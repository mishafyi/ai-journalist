/**
 * Default `LlmClient` — OpenRouter via the official `@openrouter/sdk`, with
 * DYNAMIC top-weekly-free model selection.
 *
 * Faithful in-engine replica of the host's proprietary LLM client
 * (`chatCompletion*` + dynamic model selection + `getOpenRouterUsage`/`recordUsage`).
 * The engine is domain-agnostic and imports NOTHING from a host app, so this
 * re-implements that behaviour rather than importing it. `clients/**` is the one
 * area permitted to touch the SDK + `process.env` (the API key + selection knobs).
 *
 * MODEL SELECTION. When `createOpenRouterLlm` is given no `defaultModel` and a
 * call passes no `model`, the client picks the current best free model at
 * runtime from OpenRouter's live "top-weekly, zero-price, text-in/text-out"
 * ranking (`models.list`), trying each ranked candidate with a short retry
 * budget and advancing to the next once one is exhausted (a per-instance
 * dead-set). A delisted model can therefore never silently break generation:
 * the ranking is re-checked once per process and a dead model is skipped. An
 * explicit `defaultModel` (or a per-call `model`) pins a single id and bypasses
 * selection — the original, deterministic behaviour, preserved VERBATIM.
 *
 * Three behaviours are load-bearing and replicated VERBATIM:
 *   1. The `chatRequest` envelope — `client.chat.send({ chatRequest: {...} })`.
 *      Verified unchanged from `@openrouter/sdk@0.12.79` through `0.13.21`: the
 *      nested shape, NOT the flat `{ model, messages }`.
 *   2. The non-stream guard — `if (!("choices" in res)) throw`. The streaming
 *      overload returns an `EventStream`, which has no `choices`.
 *   3. The empty-completion throw. A structurally valid but whitespace-only
 *      completion is a provider glitch (some free models intermittently return
 *      pure "\n" runs). Returning "" would silently ship a no-op; throwing makes
 *      the blank retryable — by the per-model retry here AND by a caller's own
 *      `withRetry` wrapper.
 *
 * Usage accounting mirrors the host's LLM client (`requests` + the five token
 * counters), held PER CLIENT INSTANCE and exposed via `usage()` — the golden
 * test diffs a single run's telemetry, so a per-process global would leak counts
 * across runs. The dead-model set is likewise per-instance.
 *
 * NOTE on the SDK params: `models.list` takes `sort` (a `GetModelsSort` enum
 * whose value is `"top-weekly"`), NOT `order`; plus `maxPrice` (number) and
 * `inputModalities` + `outputModalities` (comma-separated strings). These filter
 * params require `@openrouter/sdk@>=0.13` — an older SDK silently ignores them
 * and returns PAID models, so the dependency floor is `^0.13.21`.
 */
import { OpenRouter } from "@openrouter/sdk";
import type { ChatResult } from "@openrouter/sdk/models";
import { z } from "zod";
import type { ZodType } from "zod";
import type { LlmClient } from "../ports";

/**
 * Default model — a STABLE id. Consulted ONLY when a caller explicitly pins it
 * via `createOpenRouterLlm({ defaultModel: DEFAULT_MODEL })` or a per-call
 * `model`. With dynamic selection (the default when `defaultModel` is omitted),
 * the live `models.list` ranking is preferred and this id is not used.
 * @see https://openrouter.ai/meta-llama/llama-3.3-70b-instruct:free
 */
export const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

/**
 * Known-free models used ONLY when the live `models.list` ranking can't be
 * fetched (transient list outage) — so dynamic selection degrades instead of
 * hard-failing. Current `:free` ids present in the live top-weekly free list;
 * the live ranking is always preferred when reachable. Env-overridable
 * (comma-separated `OPENROUTER_FALLBACK_FREE_MODELS`) without a code change if
 * the free tier churns.
 */
export const FALLBACK_FREE_MODELS: string[] = (
  process.env.OPENROUTER_FALLBACK_FREE_MODELS ??
  [
    "openai/gpt-oss-120b:free",
    "openai/gpt-oss-20b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ].join(",")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Parse an integer env knob with a floor, falling back to `dflt` for a missing,
 * non-numeric, or below-floor value. Guards the retry budgets: `Number("")` is 0
 * and `Number("x")` is NaN, either of which would make `withRetry` run ZERO
 * iterations and throw WITHOUT ever calling the target — silently marking a
 * healthy model dead, or skipping the list fetch. Counts floor at 1; delays and
 * the TTL floor at 0.
 */
function envInt(name: string, dflt: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}

/** Per-model chat retry budget (env-overridable, floor 1). */
const MAX_ATTEMPTS_PER_MODEL = envInt("OPENROUTER_AUTO_MAX_RETRIES", 3, 1);
const BASE_DELAY_MS = envInt("OPENROUTER_AUTO_BASE_DELAY_MS", 500, 0);
/** Retry budget for the `models.list` fetch itself (distinct from the chat retry). */
const LIST_MAX_ATTEMPTS = envInt("OPENROUTER_LIST_MAX_ATTEMPTS", 2, 1);
const LIST_BASE_DELAY_MS = envInt("OPENROUTER_LIST_BASE_DELAY_MS", 300, 0);
/**
 * How long a SUCCESSFUL ranking is reused before a long-lived process re-fetches
 * the live list (env-overridable, floor 0 = always re-fetch). Bounds staleness: a
 * persistent scheduler (a long-lived process reused across cron runs) that
 * fetched the ranking once would otherwise freeze it for its whole (multi-day)
 * lifetime, so a later wave of delistings could exhaust the stale list with no
 * re-check — defeating the point of dynamic selection. Default 1 hour.
 */
const LIST_TTL_MS = envInt("OPENROUTER_LIST_TTL_MS", 3_600_000, 0);

/**
 * Per-request timeout, set ONCE at client construction via the SDK's OWN
 * `SDKOptions.timeoutMs` (`@openrouter/sdk`). `chatSend` resolves a request's
 * timeout as `options?.timeoutMs || client._options.timeoutMs || -1`, so a
 * client-level value is inherited by every `chat.send` with no per-call plumbing.
 * Bounds an SDK hang: the SDK defaults to `-1` (NO timeout), and its response
 * matcher `JSON.parse`s the body with no empty-body guard, so an intermittently-
 * empty free-provider response can leave the awaited call unsettled — hanging the
 * whole pipeline (observed on free models under load). The SDK turns `timeoutMs`
 * into an `AbortSignal.timeout` on the underlying `fetch` (`lib/sdks`), so on
 * timeout the REQUEST is aborted (the socket is released) and `chat.send` rejects
 * with a `RequestTimeoutError`; the per-model retry in `runWithSelection` then
 * advances to the next ranked candidate. Preferred over a hand-rolled
 * `Promise.race` (which would leave the hung `fetch` reading in the background)
 * AND over per-call passing (this is DRYer and covers every call site). Env-
 * overridable; default 120s (a real free-model response can be slow, but a
 * 2-minute silence is a hang). Floor 1s.
 */
const CALL_TIMEOUT_MS = envInt("OPENROUTER_CALL_TIMEOUT_MS", 120_000, 1_000);

/**
 * Minimal exponential-backoff retry. The engine's own `withRetry` is a dependency
 * the pure core injects and is not importable here, so `clients/**` inlines this.
 * Tries `fn` up to `attempts` times, sleeping `baseDelayMs * 2**i` between tries;
 * rethrows the last error when all attempts are exhausted.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * 2 ** i),
        );
      }
    }
  }
  throw lastErr;
}

/**
 * Per-process memoized ranking promise. Holds only a SUCCESSFULLY-resolved live
 * ranking, reused for up to `LIST_TTL_MS` so the `models.list` request runs at
 * most once per TTL window — NOT frozen for the whole (potentially multi-day)
 * life of a long-lived process, which would let a later wave of delistings
 * exhaust the stale list with no re-check. A fetch that exhausts its retries is
 * NOT stored — that call returns the hardcoded fallback and the cache stays
 * `null`, so a later call re-attempts the live list (a transient blip must not
 * become the permanent per-process answer). Reset early by `resetModelCache()`.
 */
let rankedModelsPromise: Promise<string[]> | null = null;
/** Epoch-ms when `rankedModelsPromise` was last set — paired with `LIST_TTL_MS`
 *  to expire a stale success memo in a long-lived process. */
let rankedModelsFetchedAt = 0;

/** One live `models.list` fetch → ranked ids. Throws on an empty/failed fetch. */
async function fetchRankedModels(client: OpenRouter): Promise<string[]> {
  const res = await client.models.list({
    // `sort` (enum "top-weekly"), NOT `order`; requires @openrouter/sdk >=0.13.
    sort: "top-weekly",
    maxPrice: 0,
    // Admit only models that both accept AND emit text.
    inputModalities: "text",
    outputModalities: "text",
  });
  const ids = res.data
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) {
    throw new Error("models.list returned no free text models");
  }
  return ids;
}

/**
 * Fetch the ranked ids of top-weekly, zero-price, text-in/text-out OpenRouter
 * models (highest-ranked first). Wrapped in `withRetry` so a transient blip is
 * retried before falling back. Memoizes only a SUCCESSFUL live ranking
 * per-process; on retry-exhaustion it logs to stderr and returns
 * `FALLBACK_FREE_MODELS` for THIS call WITHOUT caching it (the next call
 * re-attempts the live list). Selection never hard-fails. `client` defaults to
 * one built from `OPENROUTER_API_KEY`, so an adopter can call this standalone.
 */
export function getTopFreeTextModels(client?: OpenRouter): Promise<string[]> {
  if (rankedModelsPromise && Date.now() - rankedModelsFetchedAt < LIST_TTL_MS) {
    return rankedModelsPromise;
  }
  const c =
    client ??
    new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      timeoutMs: CALL_TIMEOUT_MS,
    });
  const attempt = withRetry(
    () => fetchRankedModels(c),
    LIST_MAX_ATTEMPTS,
    LIST_BASE_DELAY_MS,
  ).catch((e: unknown) => {
    // Retries exhausted → drop the cached promise so a later call re-fetches,
    // log once, and hand this caller the hardcoded fallback.
    rankedModelsPromise = null;
    process.stderr.write(
      `openrouter models.list failed after retries; using hardcoded free-model fallback: ${
        e instanceof Error ? e.message : String(e)
      }\n`,
    );
    return [...FALLBACK_FREE_MODELS];
  });
  rankedModelsPromise = attempt;
  rankedModelsFetchedAt = Date.now();
  return attempt;
}

/** Test-only: reset the per-process ranking cache so a fresh `models.list` fires. */
export function resetModelCache(): void {
  rankedModelsPromise = null;
  rankedModelsFetchedAt = 0;
}

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
 * `stripJsonControlChars()` in the host's LLM client. Some models emit a literal
 * newline/tab INSIDE a JSON string value, which `JSON.parse` rejects even when
 * the structure is valid; properly-escaped `\n` is ordinary two-character text
 * and is unaffected. Done without a regex to avoid the no-control-regex lint.
 */
function stripControlChars(s: string): string {
  return Array.from(s, (ch) =>
    (ch.codePointAt(0) ?? 32) < 0x20 ? " " : ch,
  ).join("");
}

/**
 * Build the default OpenRouter-backed `LlmClient`. `apiKey` falls back to
 * `OPENROUTER_API_KEY` (env access is permitted in `clients/**`).
 *
 * `defaultModel` is OPTIONAL:
 *   - set (or a per-call `model`) → pins that id, single attempt, VERBATIM the
 *     original deterministic behaviour;
 *   - omitted → the client DYNAMICALLY selects the current top-weekly free model,
 *     giving each ranked candidate `OPENROUTER_AUTO_MAX_RETRIES` (default 3) tries
 *     and advancing past any that exhaust (a per-instance dead-set).
 */
export function createOpenRouterLlm(opts: {
  apiKey?: string;
  defaultModel?: string;
}): OpenRouterLlmClient {
  const client = new OpenRouter({
    apiKey: opts.apiKey ?? process.env.OPENROUTER_API_KEY,
    timeoutMs: CALL_TIMEOUT_MS,
  });

  const totals: OpenRouterUsageTotals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  };

  /** Ids that burned their full retry budget on THIS client — skipped + advanced past. */
  const deadModels = new Set<string>();

  /**
   * Resolve the model, then run `send`. When `pinned` is set → one call on that
   * id (the original deterministic path). Otherwise iterate the live ranked free
   * models minus the dead-set, giving each `MAX_ATTEMPTS_PER_MODEL` tries; on a
   * model's exhaustion mark it dead, log, and advance. Throws only when every
   * candidate is exhausted.
   */
  async function runWithSelection<T>(
    send: (model: string) => Promise<T>,
    pinned: string | undefined,
  ): Promise<T> {
    if (pinned) return send(pinned);
    const ranked = await getTopFreeTextModels(client);
    const candidates = ranked.filter((m) => !deadModels.has(m));
    if (candidates.length === 0) {
      throw new Error(
        "OpenRouter dynamic selection: all free candidate models are exhausted",
      );
    }
    let lastErr: unknown;
    for (const candidate of candidates) {
      try {
        return await withRetry(
          () => send(candidate),
          MAX_ATTEMPTS_PER_MODEL,
          BASE_DELAY_MS,
        );
      } catch (e) {
        lastErr = e;
        deadModels.add(candidate);
        process.stderr.write(
          `openrouter model exhausted, advancing: ${candidate}\n`,
        );
      }
    }
    throw new Error(
      `OpenRouter dynamic selection: all free candidate models exhausted (${candidates.join(
        ", ",
      )}); last error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  /** One free-text completion on a concrete model — the original `complete` body. */
  async function sendComplete(
    model: string,
    system: string | undefined,
    prompt: string,
    temperature: number | undefined,
  ): Promise<string> {
    const response = await client.chat.send({
      chatRequest: {
        model,
        messages: [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          { role: "user" as const, content: prompt },
        ],
        temperature,
      },
    });

    // The streaming overload returns an EventStream (no `choices`). A non-stream
    // request should never hit this, but guard rather than crash on an
    // `undefined` index below.
    if (!("choices" in response)) {
      throw new Error(
        "OpenRouter returned a streaming response where a completion was expected",
      );
    }
    recordUsage(totals, response);
    const content = response.choices[0]?.message?.content;
    const text = typeof content === "string" ? content : "";
    // A structurally valid but EMPTY/whitespace completion is a provider glitch.
    // Returning "" silently lets callers ship no-ops; throwing makes the blank
    // retryable (by the per-model retry here and the caller's retry wrapper).
    if (!text.trim()) {
      throw new Error("OpenRouter returned an empty completion");
    }
    return text;
  }

  /** One structured (json_schema) completion on a concrete model — original body. */
  async function sendStructured<T>(
    model: string,
    args: {
      messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }>;
      schema: ZodType<T>;
      schemaName: string;
      temperature?: number;
    },
  ): Promise<T> {
    const response = await client.chat.send({
      chatRequest: {
        model,
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
  }

  return {
    async complete({ system, prompt, model, temperature }) {
      return runWithSelection(
        (m) => sendComplete(m, system, prompt, temperature),
        model ?? opts.defaultModel,
      );
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
      return runWithSelection(
        (m) =>
          sendStructured(m, {
            messages: args.messages,
            schema: args.schema,
            schemaName: args.schemaName,
            temperature: args.temperature,
          }),
        args.model ?? opts.defaultModel,
      );
    },
    usage() {
      return { ...totals };
    },
  };
}
