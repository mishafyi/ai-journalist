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
import type { Tracer } from "./trace";

export interface GeminiLlmConfig {
  apiKey: string;
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
 * The Gemma models share ONE 16,000 input-tokens-per-minute bucket, so a real
 * column prompt — persona, standing tests and the scraped source pages — is
 * refused outright by both, and no backoff can help: the cap is volume per
 * minute, not a transient. They stay in the list because their daily ceiling is
 * 14,400 requests against Flash-Lite's 500, which is the budget that matters
 * for the many small calls (tags, headlines, judgments) a run also makes.
 * `GEMINI_FREE_MODELS` overrides the order without a code change.
 */
export const FREE_MODELS: string[] = (
  process.env.GEMINI_FREE_MODELS ??
  "gemini-3.5-flash-lite,gemma-4-26b-a4b-it,gemma-4-31b-it,gemini-3.1-flash-lite"
)
  .split(",")
  .map((m) => m.trim())
  .filter((m) => m !== "");

/** Rounds through the whole candidate list before giving up. */
const ROTATION_ROUNDS = 8;

/** How long the API asked us to wait, or null when the error is not a throttle. */
function throttleDelayMs(err: unknown): number | null {
  const text = String(err instanceof Error ? err.message : err);
  const asked = text.match(/"retryDelay":\s*"(\d+)s"/);
  if (asked !== null) return Number(asked[1]) * 1000;
  if (/"code":\s*429|RESOURCE_EXHAUSTED/.test(text)) return 30_000;
  if (/"code":\s*503|high demand|UNAVAILABLE/.test(text)) return 10_000;
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
  log?: (line: string) => void,
): <T>(label: string, pinned: string | undefined, send: (model: string) => Promise<T>) => Promise<T> {
  const coolUntil = new Map<string, number>();
  return async <T>(label: string, pinned: string | undefined, send: (model: string) => Promise<T>): Promise<T> => {
    const candidates = pinned === undefined ? models : [pinned];
    if (candidates.length === 0) throw new Error("gemini: no models configured");
    let last: unknown;
    for (let round = 1; round <= ROTATION_ROUNDS; round += 1) {
      const ready = candidates.filter((m) => (coolUntil.get(m) ?? 0) <= Date.now());
      if (ready.length === 0) {
        const wait = Math.max(0, Math.min(...candidates.map((m) => coolUntil.get(m) ?? 0)) - Date.now());
        log?.(`gemini: ${label} — every free model is cooling down, waiting ${Math.round(wait / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      for (const model of ready) {
        try {
          return await send(model);
        } catch (err: unknown) {
          const wait = throttleDelayMs(err);
          if (wait === null) throw err;
          last = err;
          coolUntil.set(model, Date.now() + wait);
          log?.(`gemini: ${label} — ${model} rate-limited, cooling ${Math.round(wait / 1000)}s; advancing`);
        }
      }
    }
    throw new Error(
      `gemini: ${label} — every free model was rate-limited across ${ROTATION_ROUNDS} rounds ` +
        `(${candidates.join(", ")}); last error: ${last instanceof Error ? last.message : String(last)}`,
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
  const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
  const rotate = createRotation(cfg.models, cfg.log);
  const pin = (candidate: string | undefined): string | undefined =>
    candidate === undefined || candidate.trim() === "" ? undefined : candidate;

  return {
    async complete({ system, prompt, model, temperature }) {
      const request = {
        model: pin(model) ?? cfg.models.join(" > "),
        ...(temperature === undefined ? {} : { temperature }),
        ...(system === undefined ? {} : { system }),
        prompt,
      };
      let served = "";
      try {
        const res = await rotate("complete", pin(model), (chosen) => {
          served = chosen;
          return ai.models.generateContent({
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
        cfg.trace?.llm({ ...request, response: text });
        return text;
      } catch (err: unknown) {
        cfg.trace?.llm({ ...request, error: String(err) });
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
        model: pin(args.model) ?? cfg.models.join(" > "),
        ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
        schemaName: args.schemaName,
        messages: args.messages,
      };
      let text: string;
      try {
        const res = await rotate(args.schemaName, pin(args.model), (chosen) =>
          ai.models.generateContent({
            model: chosen,
            contents,
            config: {
              responseMimeType: "application/json",
              responseJsonSchema: z.toJSONSchema(args.schema) as Record<string, unknown>,
              ...(system === "" ? {} : { systemInstruction: system }),
              ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
            },
          }),
        );
        text = res.text ?? "";
      } catch (err: unknown) {
        cfg.trace?.llm({ ...request, error: String(err) });
        throw err;
      }
      cfg.trace?.llm({ ...request, response: text });
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
