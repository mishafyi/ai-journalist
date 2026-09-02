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
  /** Model every call uses unless it passes its own, e.g. "gemma-4-31b-it". */
  model: string;
  trace?: Tracer;
  /** Where a throttle wait announces itself; silent when absent. */
  log?: (line: string) => void;
}

const THROTTLE_ATTEMPTS = 8;

/** How long the API asked us to wait, or null when the error is not a throttle. */
function throttleDelayMs(err: unknown): number | null {
  const text = String(err instanceof Error ? err.message : err);
  const asked = text.match(/"retryDelay":\s*"(\d+)s"/);
  if (asked !== null) return Number(asked[1]) * 1000;
  if (/"code":\s*429|RESOURCE_EXHAUSTED/.test(text)) return 30_000;
  if (/"code":\s*503|high demand|UNAVAILABLE/.test(text)) return 10_000;
  return null;
}

async function throttled<T>(label: string, run: () => Promise<T>, log?: (line: string) => void): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= THROTTLE_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (err: unknown) {
      last = err;
      const wait = throttleDelayMs(err);
      if (wait === null || attempt === THROTTLE_ATTEMPTS) throw err;
      log?.(`gemini: ${label} throttled (attempt ${attempt}/${THROTTLE_ATTEMPTS}) — waiting ${Math.round(wait / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
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
  const resolveModel = (candidate: string | undefined): string =>
    candidate === undefined || candidate.trim() === "" ? cfg.model : candidate;

  return {
    async complete({ system, prompt, model, temperature }) {
      const resolved = resolveModel(model);
      const request = {
        model: resolved,
        ...(temperature === undefined ? {} : { temperature }),
        ...(system === undefined ? {} : { system }),
        prompt,
      };
      try {
        const res = await throttled(
          "complete",
          () =>
            ai.models.generateContent({
              model: resolved,
              contents: prompt,
              config: {
                ...(system === undefined ? {} : { systemInstruction: system }),
                ...(temperature === undefined ? {} : { temperature }),
              },
            }),
          cfg.log,
        );
        const text = res.text ?? "";
        if (!text.trim()) throw new Error(`Gemini returned an empty completion (model=${resolved})`);
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
      const resolved = resolveModel(args.model);
      const system = args.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const contents = args.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const request = {
        model: resolved,
        ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
        schemaName: args.schemaName,
        messages: args.messages,
      };
      let text: string;
      try {
        const res = await throttled(
          args.schemaName,
          () =>
            ai.models.generateContent({
              model: resolved,
              contents,
              config: {
                responseMimeType: "application/json",
                responseJsonSchema: z.toJSONSchema(args.schema) as Record<string, unknown>,
                ...(system === "" ? {} : { systemInstruction: system }),
                ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
              },
            }),
          cfg.log,
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
