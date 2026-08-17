/**
 * clients/gemini-llm.ts — Google AI (Gemini / Gemma) as an `LlmClient`.
 *
 * Upstreamed from a paper that ran its whole desk on the AI Studio free tier.
 * The interesting part is not the SDK call, it is surviving the free tier:
 *
 *  - KEY ROTATION. AI Studio quotas are per PROJECT, so a key from a second
 *    project is an independent pool, not a share of the same one. Each key gets
 *    its own LANE with its own pacing clock, so adding a key genuinely doubles
 *    throughput instead of splitting one budget. Lanes rotate round-robin.
 *  - MODEL CHAIN PER LANE. A lane that exhausts its current model falls to the
 *    next one on its own, independently of the other lanes; a lane with nothing
 *    left leaves the rotation. Only when every lane is dead does a call throw.
 *  - SERVER-SPECIFIED BACKOFF. A 429 carries Google's own `retryDelay`, and it
 *    beats any client-side guess. That is the reason this is hand-rolled rather
 *    than wrapped in a generic retry helper — a generic one cannot read it.
 *  - TYPED ERRORS. The SDK's `ApiError` carries `.status`, so classification
 *    reads a number instead of sniffing message strings. The one exception is
 *    `retryDelay`, which Google ships only inside the 429 body text.
 *
 * Config is injected, never read from the environment here — the host adapter
 * decides where keys come from.
 */
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { ZodType } from "zod";
import type { LlmClient } from "../ports";

export interface GeminiLlmConfig {
  /**
   * One or more AI Studio API keys. Keys from DIFFERENT Google Cloud projects
   * are independent quota pools; keys from the same project are not, and will
   * simply share one budget across two lanes.
   */
  apiKeys: readonly string[];
  /**
   * Model fallback chain, best first. A lane walks down it as models exhaust.
   * Defaults deliberately lead with Gemma: on the free tier it carries the
   * highest requests-per-day by a wide margin, and the Gemini models are there
   * as a floor rather than a target.
   */
  models?: readonly string[];
  /** Requests per minute PER KEY, from the account's own quota page. */
  rpm?: number;
  /** Attempts against one lane+model before that pair is judged unusable. */
  quotaRetries?: number;
  log?: (line: string) => void;
}

const DEFAULT_MODELS = [
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
] as const;

/** Free-tier default. Override from the account's quota page. */
const DEFAULT_RPM = 30;
const DEFAULT_QUOTA_RETRIES = 3;
/** Floor for a quota wait when the server did not name one. */
const MIN_QUOTA_WAIT_MS = 15_000;
const TRANSIENT_WAIT_MS = 8_000;

export interface LaneState {
  name: string;
  /** Where this lane has reached in the model chain. */
  modelIdx: number;
  dead: boolean;
}

/**
 * Which lane serves the next call, or null when every lane is exhausted.
 * Pure, so the rotation is testable without an SDK: round-robin over the LIVE
 * lanes, which means a dying lane is skipped rather than re-tried in order.
 */
export function pickLane<L extends LaneState>(lanes: readonly L[], cursor: number): L | null {
  const alive = lanes.filter((l) => !l.dead);
  if (alive.length === 0) return null;
  return alive[cursor % alive.length];
}

/**
 * What happens to a lane whose current model just failed: step down its own
 * chain, or leave the rotation when it has nothing left. MUTATES the lane —
 * it is the lane's own state machine — and returns which happened so the
 * caller can log it.
 */
export function demoteLane(lane: LaneState, modelCount: number): "fallback" | "dead" {
  if (lane.modelIdx + 1 < modelCount) {
    lane.modelIdx += 1;
    return "fallback";
  }
  lane.dead = true;
  return "dead";
}

interface Lane extends LaneState {
  ai: GoogleGenAI;
  /** Epoch ms of this lane's last request — its own pacing clock. */
  lastCallAt: number;
}

interface Classified {
  quota: boolean;
  transient: boolean;
  /** Google's own retryDelay, in ms. 0 when the server did not name one. */
  retryDelayMs: number;
  status: number | undefined;
  msg: string;
}

/** Read an SDK error the typed way first, message text only as a last resort. */
export function classifyGeminiError(err: unknown): Classified {
  const status =
    err instanceof ApiError
      ? err.status
      : typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : undefined;
  const msg = String((err as { message?: unknown })?.message ?? err);
  // RetryInfo is only ever in the body text, even with a typed error.
  const named = msg.match(/retryDelay[^0-9]*(\d+)/);
  return {
    quota: status === 429 || msg.includes("RESOURCE_EXHAUSTED"),
    transient: status === 500 || status === 503 || msg.includes("UNAVAILABLE"),
    retryDelayMs: named === null ? 0 : Number(named[1]) * 1000,
    status,
    msg,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface GenerateArgs {
  system: string | undefined;
  prompt: string;
  temperature: number | undefined;
  responseSchema: Record<string, unknown> | undefined;
}

/**
 * Google AI as an `LlmClient`. Throws at construction when no key is supplied —
 * a client that cannot call anything is a configuration error, not a runtime
 * one, and failing here beats failing on the first article.
 */
export function createGeminiLlm(cfg: GeminiLlmConfig): LlmClient {
  const keys = cfg.apiKeys.filter((k) => typeof k === "string" && k.trim() !== "");
  if (keys.length === 0) {
    throw new Error("createGeminiLlm: at least one API key is required (apiKeys was empty)");
  }
  const models = [...(cfg.models ?? DEFAULT_MODELS)].filter((m, i, a) => a.indexOf(m) === i);
  if (models.length === 0) throw new Error("createGeminiLlm: models must not be empty");

  const rpm = cfg.rpm ?? DEFAULT_RPM;
  // A third of the nominal rate: the free tier's accounting is bursty enough
  // that pacing at exactly RPM still trips 429s.
  const callGapMs = Math.ceil(60_000 / (rpm / 3));
  const quotaRetries = cfg.quotaRetries ?? DEFAULT_QUOTA_RETRIES;
  const log = cfg.log ?? ((): void => {});

  const lanes: Lane[] = keys.map((key, i) => ({
    name: `key${i + 1}`,
    ai: new GoogleGenAI({ apiKey: key }),
    lastCallAt: 0,
    modelIdx: 0,
    dead: false,
  }));
  let cursor = 0;

  /** Paced, quota-aware attempts against ONE lane+model pair. */
  async function attempt(lane: Lane, model: string, args: GenerateArgs): Promise<string> {
    for (let n = 0; ; n += 1) {
      const wait = lane.lastCallAt + callGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lane.lastCallAt = Date.now();
      try {
        const res = await lane.ai.models.generateContent({
          model,
          contents: args.prompt,
          config: {
            ...(args.system === undefined ? {} : { systemInstruction: args.system }),
            ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
            ...(args.responseSchema === undefined
              ? {}
              : { responseMimeType: "application/json", responseSchema: args.responseSchema }),
          },
        });
        const u = res.usageMetadata;
        if (u !== undefined) {
          log(
            `gemini: ${lane.name}/${model} in=${u.promptTokenCount ?? "?"} ` +
              `out=${u.candidatesTokenCount ?? "?"} thought=${u.thoughtsTokenCount ?? 0} ` +
              `total=${u.totalTokenCount ?? "?"}`,
          );
        }
        const text = res.text ?? "";
        // An empty completion is a CONTENT failure, not a transport one — it is
        // the caller's retry helper's business, so it leaves here as a throw
        // rather than burning this lane's model chain.
        if (text.trim() === "") throw new Error(`gemini: ${lane.name}/${model} returned an empty completion`);
        return text;
      } catch (err: unknown) {
        const c = classifyGeminiError(err);
        // A hard error (unknown model id, bad key, malformed request) is not
        // worth retrying against the same pair.
        if (!c.quota && !c.transient) throw err;
        if (n >= quotaRetries) throw err;
        const delay = c.quota ? Math.max(c.retryDelayMs, MIN_QUOTA_WAIT_MS) : TRANSIENT_WAIT_MS;
        log(
          `gemini: ${lane.name}/${model} limited (status ${c.status ?? "?"}), ` +
            `waiting ${Math.round(delay / 1000)}s — ${c.msg.slice(0, 120)}`,
        );
        // Jitter so parallel lanes do not resynchronize onto the same second.
        await sleep(delay + Math.random() * 2_000);
      }
    }
  }

  /** Rotate across live lanes; fall down a lane's model chain as models die. */
  async function generate(args: GenerateArgs): Promise<string> {
    for (;;) {
      const lane = pickLane(lanes, cursor);
      if (lane === null) {
        throw new Error("gemini: every key/model lane is exhausted for this run");
      }
      cursor += 1;
      const model = models[lane.modelIdx];
      try {
        return await attempt(lane, model, args);
      } catch (err: unknown) {
        const detail = String((err as { message?: unknown })?.message ?? err).slice(0, 120);
        if (demoteLane(lane, models.length) === "fallback") {
          log(`gemini: ${lane.name} falling back ${model} → ${models[lane.modelIdx]} — ${detail}`);
        } else {
          log(`gemini: ${lane.name} exhausted at ${model}, leaving rotation — ${detail}`);
        }
      }
    }
  }

  return {
    async complete({ system, prompt, model, temperature }) {
      // A per-call model pins THIS call to one model, bypassing the chain: the
      // caller asked for that model specifically.
      if (model !== undefined) {
        const lane = lanes.find((l) => !l.dead) ?? lanes[0];
        return attempt(lane, model, { system, prompt, temperature, responseSchema: undefined });
      }
      return generate({ system, prompt, temperature, responseSchema: undefined });
    },

    async completeStructured<T>(args: {
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      schema: ZodType<T>;
      schemaName: string;
      model?: string;
      temperature?: number;
    }): Promise<T> {
      // Gemini takes ONE system instruction plus the conversation, so system
      // turns are joined and the rest is flattened in order.
      const system = args.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const prompt = args.messages
        .filter((m) => m.role !== "system")
        .map((m) => m.content)
        .join("\n\n");
      const request: GenerateArgs = {
        system: system === "" ? undefined : system,
        prompt,
        temperature: args.temperature,
        responseSchema: z.toJSONSchema(args.schema) as Record<string, unknown>,
      };
      const text =
        args.model === undefined
          ? await generate(request)
          : await attempt(lanes.find((l) => !l.dead) ?? lanes[0], args.model, request);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `gemini structured response for "${args.schemaName}" was not valid JSON: ${text.slice(0, 200)}`,
        );
      }
      // Schema-constrained decoding still needs validating: responseSchema
      // constrains SHAPE, not the semantics Zod refinements encode.
      return args.schema.parse(parsed);
    },
  };
}
