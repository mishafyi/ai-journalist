/**
 * `LlmClient` adapter for the Gemini API (https://ai.google.dev) through the
 * official `@google/genai` SDK — Gemini models and the Gemma models Google
 * serves on the same endpoint (`gemma-4-31b-it`: 262K context).
 *
 * Mirrors the Ollama client's contract: free-text `complete`, JSON-schema
 * `completeStructured` validated against the caller's Zod schema, empty
 * completions throw so the caller's retry wrapper can re-ask.
 *
 * Two things the endpoint does that the local runner never did:
 *  - It rate-limits. A 429 carries a `retryDelay`; a 503 is "high demand".
 *    Both are waited out here and the request re-sent verbatim, because they
 *    mean "not yet", not "no" — a content failure still belongs to the
 *    engine's helpers.
 *  - Gemma does not enforce the response schema as a grammar the way Gemini
 *    does: it follows the schema and then sometimes keeps writing. The first
 *    complete JSON value is taken and Zod judges it.
 */
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { ZodType } from "zod";
import type { LlmClient } from "../ports";
import { describeError } from "./trace";
import type { Tracer } from "./trace";

export interface GeminiLlmConfig {
  /** Every key available, each from a SEPARATE Google project. Free-tier
   *  limits are per project (rate-limits doc: "applied per project, not per
   *  API key"), so N keys from N projects multiply the budget N times — and N
   *  keys from ONE project multiply nothing. Order is irrelevant: calls start
   *  at a rotating offset so no single key carries the daily count. */
  apiKeys: readonly string[];
  /** Free models in preference order; the first that answers serves the call.
   *  A call naming its own model pins to that one and does not rotate. */
  models: readonly string[];
  trace?: Tracer;
  /** Where a throttle wait announces itself; silent when absent. */
  log?: (line: string) => void;
}

/**
 * The free models this rotates through, best first. Order is measured, not
 * guessed (2026-09-03, one desk-shaped prompt per model):
 *
 *   prompt ~6.3K tokens  3.5-flash-lite 1.7s | gemma-4-26b 4.7s | gemma-4-31b 24.3s
 *   prompt ~14.3K tokens 3.5-flash-lite 0.9s | BOTH gemma models 429, limit=16000
 *
 * GEMMA LEADS BY OPERATOR CHOICE (2026-09-03), and the key ring is what makes
 * that affordable. Within one project the two Gemma models share a single
 * 16,000 input-tokens-per-minute bucket; across twelve projects there are
 * twelve such buckets, so the cap that used to end runs is now something the
 * rotation walks around. Gemma also has the daily headroom — 14,400 requests
 * against Flash-Lite's 500.
 *
 * Flash-Lite still sits behind them, and not only as a spare: a SINGLE request
 * over 16,000 input tokens is refused by Gemma on every key, because no per-
 * minute budget can hold a prompt that large. Those calls fall through to
 * Flash-Lite, which took the same 14.3K-token prompt in 0.9s.
 * `GEMINI_FREE_MODELS` overrides the order without a code change.
 */
export const FREE_MODELS: string[] = (
  process.env.GEMINI_FREE_MODELS ??
  "gemma-4-31b-it,gemma-4-26b-a4b-it,gemini-3.5-flash-lite,gemini-3.1-flash-lite"
)
  .split(",")
  .map((m) => m.trim())
  .filter((m) => m !== "");

/** Rounds through the whole candidate list before giving up. */
const ROTATION_ROUNDS = 8;

/** Why a failed call is worth trying elsewhere, and how long to shun the pair
 *  that produced it. `null` means the error is a real fault to surface. */
interface Retryable {
  waitMs: number;
  reason: "rate-limited" | "transport failure";
}

/**
 * Classify an error as retryable-elsewhere or not.
 *
 * TRANSPORT FAILURES ARE RETRYABLE, and getting that wrong took the desk down
 * for an hour on 2026-09-03: undici raises a bare `TypeError: fetch failed`
 * for a dropped socket, and because it carries no HTTP status and no response
 * body, every status regex below missed it, this returned null, and the
 * rotation treated a dead connection as a malformed request and rethrew. Five
 * consecutive runs died mid-column on it. A dropped socket is neither a rate
 * limit nor a bug in the request — it is the one thing a retry reliably fixes,
 * and the next key is a fresh connection.
 *
 * The cooldown for one is deliberately short: the model and key are not at
 * fault, so shunning them for 30s would be punishing the wrong thing.
 */
function retryableAfter(err: unknown): Retryable | null {
  // The whole chain: the socket codes below live on the CAUSE, never on the
  // `fetch failed` wrapper, so matching the top-level message alone would make
  // every pattern except "fetch failed" unreachable.
  const text = describeError(err);
  const asked = text.match(/"retryDelay":\s*"(\d+)s"/);
  if (asked !== null) return { waitMs: Number(asked[1]) * 1000, reason: "rate-limited" };
  if (/"code":\s*429|RESOURCE_EXHAUSTED/.test(text)) return { waitMs: 30_000, reason: "rate-limited" };
  if (/"code":\s*503|high demand|UNAVAILABLE/.test(text)) return { waitMs: 10_000, reason: "rate-limited" };
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|terminated|other side closed/i.test(text)) {
    return { waitMs: 2_000, reason: "transport failure" };
  }
  return null;
}

/**
 * Run `send` against the first free model that will take it.
 *
 * A rate-limited model is put on COOLDOWN and skipped, not retired: every
 * Gemini free-tier limit that bites here is per-minute, so the model is usable
 * again shortly and retiring it would throw away the run's best option over a
 * transient. (The OpenRouter client's equivalent marks a model dead for the
 * client's life — right there, because those limits are credit exhaustion.)
 *
 * Waiting only happens when EVERY candidate is cooling; otherwise the next
 * model serves the call immediately, which is the whole point. A non-limit
 * error is a real failure and propagates at once rather than costing the
 * caller a tour of every model.
 */
export function createRotation(
  models: readonly string[],
  keyCount: number,
  log?: (line: string) => void,
): <T>(label: string, pinned: string | undefined, send: (model: string, keyIndex: number) => Promise<T>) => Promise<T> {
  // Cooldowns are per MODEL-AND-KEY. A model limited on one project's key is
  // fine on the next project's, so retiring the model outright would throw
  // away eleven working budgets over one exhausted one.
  const coolUntil = new Map<string, number>();
  const slot = (model: string, key: number): string => `${model}#${key}`;
  // Where the key ring starts, advanced per call. Without this every call
  // begins at key 0, which would burn one project's 14,400 daily requests
  // while the other eleven sat idle.
  let cursor = 0;

  return async <T>(
    label: string,
    pinned: string | undefined,
    send: (model: string, keyIndex: number) => Promise<T>,
  ): Promise<T> => {
    const candidateModels = pinned === undefined ? models : [pinned];
    if (candidateModels.length === 0) throw new Error("gemini: no models configured");
    if (keyCount === 0) throw new Error("gemini: no api keys configured");
    const start = cursor;
    cursor = (cursor + 1) % keyCount;
    // Model-major: every key for the preferred model before the next model,
    // so an operator's first choice is genuinely exhausted before we move off
    // it. The keys themselves rotate so the load spreads across projects.
    const pairs = candidateModels.flatMap((model) =>
      Array.from({ length: keyCount }, (_, n) => ({ model, key: (start + n) % keyCount })),
    );

    let last: unknown;
    for (let round = 1; round <= ROTATION_ROUNDS; round += 1) {
      const ready = pairs.filter((p) => (coolUntil.get(slot(p.model, p.key)) ?? 0) <= Date.now());
      if (ready.length === 0) {
        const soonest = Math.min(...pairs.map((p) => coolUntil.get(slot(p.model, p.key)) ?? 0));
        const wait = Math.max(0, soonest - Date.now());
        log?.(`gemini: ${label} — every model/key pair is cooling, waiting ${Math.round(wait / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      let announced = "";
      for (const { model, key } of ready) {
        try {
          return await send(model, key);
        } catch (err: unknown) {
          const retry = retryableAfter(err);
          if (retry === null) throw err;
          last = err;
          coolUntil.set(slot(model, key), Date.now() + retry.waitMs);
          // One line per MODEL-AND-REASON, not per key: twelve keys would
          // otherwise put twelve near-identical lines in the log for every
          // refused call. The reason is named so a sick network reads as a
          // network problem instead of hiding behind "rate-limited".
          if (announced !== `${model}|${retry.reason}`) {
            announced = `${model}|${retry.reason}`;
            log?.(`gemini: ${label} — ${model} ${retry.reason} on key ${key + 1}/${keyCount}, trying its other keys`);
          }
        }
      }
    }
    throw new Error(
      `gemini: ${label} — every model failed on all ${keyCount} key(s) across ` +
        `${ROTATION_ROUNDS} rounds (${candidateModels.join(", ")}); last error: ` +
        `${describeError(last)}`,
    );
  };
}

/** The first complete JSON object or array in `text`, fences and trailing prose stripped. */
function firstJsonValue(text: string): string {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = stripped.search(/[[{]/);
  if (start === -1) return stripped;
  let depth = 0;
  let inString = false;
  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return stripped.slice(start);
}

export function createGeminiLlm(cfg: GeminiLlmConfig): LlmClient {
  // One SDK client per key — the key is fixed at construction, so a ring of
  // keys is a ring of clients.
  const ring = cfg.apiKeys.map((apiKey) => new GoogleGenAI({ apiKey }));
  const rotate = createRotation(cfg.models, ring.length, cfg.log);
  const pin = (candidate: string | undefined): string | undefined =>
    candidate === undefined || candidate.trim() === "" ? undefined : candidate;

  return {
    async complete({ system, prompt, model, temperature }) {
      // `model` is filled in AFTER the call with the id that actually served
      // it. Recording the candidate list instead would hide the one fact the
      // trace is for: which model wrote this, when any of four might have.
      const request = {
        model: "",
        ...(temperature === undefined ? {} : { temperature }),
        ...(system === undefined ? {} : { system }),
        prompt,
      };
      let served = "";
      try {
        const res = await rotate("complete", pin(model), (chosen, key) => {
          served = chosen;
          return ring[key].models.generateContent({
            model: chosen,
            contents: prompt,
            config: {
              ...(system === undefined ? {} : { systemInstruction: system }),
              ...(temperature === undefined ? {} : { temperature }),
            },
          });
        });
        const text = res.text ?? "";
        if (!text.trim()) throw new Error(`Gemini returned an empty completion (model=${served})`);
        cfg.trace?.llm({ ...request, model: served, response: text });
        return text;
      } catch (err: unknown) {
        cfg.trace?.llm({ ...request, model: served, error: describeError(err) });
        throw err;
      }
    },

    async completeStructured<T>(args: {
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      schema: ZodType<T>;
      schemaName: string;
      model?: string;
      temperature?: number;
    }): Promise<T> {
      const system = args.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const contents = args.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const request = {
        model: "",
        ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
        schemaName: args.schemaName,
        messages: args.messages,
      };
      let served = "";
      let text: string;
      try {
        const res = await rotate(args.schemaName, pin(args.model), (chosen, key) => {
          served = chosen;
          return ring[key].models.generateContent({
            model: chosen,
            contents,
            config: {
              responseMimeType: "application/json",
              responseJsonSchema: z.toJSONSchema(args.schema) as Record<string, unknown>,
              ...(system === "" ? {} : { systemInstruction: system }),
              ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
            },
          });
        });
        text = res.text ?? "";
      } catch (err: unknown) {
        cfg.trace?.llm({ ...request, model: served, error: describeError(err) });
        throw err;
      }
      cfg.trace?.llm({ ...request, model: served, response: text });
      let parsed: unknown;
      try {
        parsed = JSON.parse(firstJsonValue(text));
      } catch {
        throw new Error(`Gemini structured response was not valid JSON: ${text.slice(0, 200)}`);
      }
      return args.schema.parse(parsed);
    },
  };
}
