/**
 * Default `LlmClient` — OpenRouter via the official `@openrouter/sdk`.
 *
 * Faithful in-engine replica of the host's proprietary LLM client
 * (`chatCompletion` + `getOpenRouterUsage`/`recordUsage`). The engine is
 * domain-agnostic and imports NOTHING from a host app, so this re-implements that
 * behaviour rather than importing it. `clients/**` is the one area
 * permitted to touch the SDK + `process.env` (the API key).
 *
 * Three behaviours are load-bearing and replicated VERBATIM:
 *   1. The `chatRequest` envelope — `client.chat.send({ chatRequest: {...} })`.
 *      The installed `@openrouter/sdk@0.12.79` uses this nested shape, NOT the
 *      flat `{ model, messages }` of a newer SDK.
 *   2. The non-stream guard — `if (!("choices" in res)) throw`. The streaming
 *      overload returns an `EventStream`, which has no `choices`.
 *   3. The empty-completion throw. A structurally valid but whitespace-only
 *      completion is a provider glitch (`owl-alpha` intermittently returns pure
 *      "\n" runs). Returning "" would silently ship a no-op; throwing makes the
 *      blank retryable by the caller's `withRetry` wrapper.
 *
 * Usage accounting mirrors the host's LLM client (`requests` + the five token
 * counters), but is held PER CLIENT INSTANCE and exposed via `usage()` — the
 * golden test diffs a single run's telemetry, so a per-process global would
 * leak counts across runs.
 */
import { OpenRouter } from "@openrouter/sdk";
import type { ChatResult } from "@openrouter/sdk/models";
import { z } from "zod";
import type { ZodType } from "zod";
import type { LlmClient } from "../ports";

/**
 * Default model — a STABLE id, matching the host's LLM client `DEFAULT_MODEL`.
 * Llama 3.3 70B Instruct (free): high-quality instruction-following for content
 * generation. Never `owl-alpha` (an unstable alias that returns "\n" runs).
 * @see https://openrouter.ai/meta-llama/llama-3.3-70b-instruct:free
 */
export const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

/** Cumulative LLM usage for one client, accumulated per successful call. */
export interface OpenRouterUsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

/** An `LlmClient` that also reports its cumulative OpenRouter token usage. */
export interface OpenRouterLlmClient extends LlmClient {
  /** Snapshot (copy) of this client's cumulative usage — diff two snapshots to
   *  measure one call or pipeline stage. Failed/retried calls never return a
   *  response, so they are not counted. */
  usage(): OpenRouterUsageTotals;
}

/**
 * Accumulate the SDK's usage report (`ChatUsage`) into the running totals —
 * mirrors `recordUsage()` in the host's LLM client. Never discard observability data.
 */
function recordUsage(totals: OpenRouterUsageTotals, data: ChatResult): void {
  totals.requests += 1;
  const usage = data.usage;
  if (usage) {
    totals.promptTokens += usage.promptTokens;
    totals.completionTokens += usage.completionTokens;
    totals.totalTokens += usage.totalTokens;
    totals.reasoningTokens +=
      usage.completionTokensDetails?.reasoningTokens ?? 0;
    totals.cachedTokens += usage.promptTokensDetails?.cachedTokens ?? 0;
  }
}

/**
 * Replace raw control characters (code point < 0x20) with a space — mirrors
 * `stripJsonControlChars()` in the host's LLM client. Some models (owl-alpha) emit a
 * literal newline/tab INSIDE a JSON string value, which `JSON.parse` rejects
 * even when the structure is valid; properly-escaped `\n` is ordinary
 * two-character text and is unaffected. Done without a regex to avoid the
 * no-control-regex lint.
 */
function stripControlChars(s: string): string {
  return Array.from(s, (ch) =>
    (ch.codePointAt(0) ?? 32) < 0x20 ? " " : ch,
  ).join("");
}

/**
 * Build the default OpenRouter-backed `LlmClient`. `apiKey` falls back to
 * `OPENROUTER_API_KEY` (env access is permitted in `clients/**`);
 * `defaultModel` must be a stable id and is used when a call omits `model`.
 */
export function createOpenRouterLlm(opts: {
  apiKey?: string;
  defaultModel: string;
}): OpenRouterLlmClient {
  const client = new OpenRouter({
    apiKey: opts.apiKey ?? process.env.OPENROUTER_API_KEY,
  });

  const totals: OpenRouterUsageTotals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  };

  return {
    async complete({ system, prompt, model, temperature }) {
      const response = await client.chat.send({
        chatRequest: {
          model: model ?? opts.defaultModel,
          messages: [
            ...(system ? [{ role: "system" as const, content: system }] : []),
            { role: "user" as const, content: prompt },
          ],
          temperature,
        },
      });

      // The streaming overload returns an EventStream (no `choices`). A
      // non-stream request should never hit this, but guard rather than crash
      // on an `undefined` index below.
      if (!("choices" in response)) {
        throw new Error(
          "OpenRouter returned a streaming response where a completion was expected",
        );
      }
      recordUsage(totals, response);
      const content = response.choices[0]?.message?.content;
      const text = typeof content === "string" ? content : "";
      // A structurally valid but EMPTY/whitespace completion is a provider
      // glitch. Returning "" silently lets callers ship no-ops; throwing makes
      // the blank retryable by the caller's retry wrapper.
      if (!text.trim()) {
        throw new Error("OpenRouter returned an empty completion");
      }
      return text;
    },
    async completeStructured<T>(args: {
      messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }>;
      schema: ZodType<T>;
      schemaName: string;
      model?: string;
      temperature?: number;
    }): Promise<T> {
      const response = await client.chat.send({
        chatRequest: {
          model: args.model ?? opts.defaultModel,
          messages: args.messages,
          temperature: args.temperature,
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
              name: args.schemaName,
              strict: true,
              schema: z.toJSONSchema(args.schema),
            },
          },
        },
      });
      if (!("choices" in response)) {
        throw new Error(
          "OpenRouter returned a streaming response where a completion was expected",
        );
      }
      recordUsage(totals, response);
      const content = response.choices[0]?.message?.content;
      const text = typeof content === "string" ? content : "";
      if (!text.trim()) {
        throw new Error("OpenRouter returned an empty completion");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripControlChars(text));
      } catch {
        throw new Error(
          `OpenRouter structured response was not valid JSON: ${text.slice(0, 200)}`,
        );
      }
      return args.schema.parse(parsed);
    },
    usage() {
      return { ...totals };
    },
  };
}
