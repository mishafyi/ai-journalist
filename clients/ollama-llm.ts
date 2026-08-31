/**
 * `LlmClient` adapter for a local/LAN Ollama server (https://ollama.com).
 *
 * Mirrors the OpenRouter client's contract exactly: free-text `complete`,
 * grammar-constrained `completeStructured` (Ollama's `format` field takes a
 * JSON Schema and constrains decoding server-side, so the reply can't wrap the
 * data in prose), empty completions throw so the caller's retry wrapper can
 * re-ask. CONTENT retries belong to the engine's helpers; the only thing
 * retried in here is a request that never got an answer at all (see
 * postWithRetry) — a dropped connection is worth re-sending verbatim, and a
 * bad completion is not.
 */
import { z } from "zod";
import type { ZodType } from "zod";
import type { LlmClient } from "../ports";
import type { Tracer } from "./trace";

export interface OllamaLlmConfig {
  /** Server base URL, e.g. "http://Mikes-Mac-mini.local:11434". */
  baseUrl: string;
  /** Model tag every call uses unless it passes its own, e.g. "gemma4:e4b". */
  model: string;
  /** Context-window / keep-alive overrides forwarded into every request
   *  (`options.num_ctx`, top-level `keep_alive`). The client today sends only
   *  `temperature`; Ollama silently truncates over-long prompts server-side
   *  (a server log line, no client error) — this engine's 24K-char extraction
   *  chunks and research-block section prompts mean truncation would run
   *  extraction/audit on partial evidence. Omitted keys are sent ABSENT so
   *  the server's own env config stays authoritative. Recommended:
   *  `{ numCtx: 32768, keepAlive: "30m" }`. */
  options?: {
    numCtx?: number;
    keepAlive?: string;
  };
  /** When set, every call is recorded into its pipeline STEP's file — the
   *  COMPLETE request (system/prompt/messages, model, temperature, schema
   *  name) and the COMPLETE response, untruncated; errors too. Share one
   *  tracer with the search client so a step's model calls and its searches
   *  land in the same file (`clients/trace.ts`). */
  trace?: Tracer;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

async function chat(args: {
  baseUrl: string;
  model: string;
  messages: OllamaChatMessage[];
  temperature: number | undefined;
  format: Record<string, unknown> | undefined;
  numCtx: number | undefined;
  keepAlive: string | undefined;
  /** Where a transport retry announces itself; silent when absent. */
  log?: (line: string) => void;
}): Promise<string> {
  const options = {
    ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
    ...(args.numCtx === undefined ? {} : { num_ctx: args.numCtx }),
  };
  const body = JSON.stringify({
    model: args.model,
    messages: args.messages,
    stream: false,
    ...(args.format === undefined ? {} : { format: args.format }),
    options,
    ...(args.keepAlive === undefined ? {} : { keep_alive: args.keepAlive }),
  });
  const res = await postWithRetry(`${args.baseUrl}/api/chat`, body, args.model, args.log);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Ollama /api/chat failed: HTTP ${res.status} model=${args.model} body=${errText.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as OllamaChatResponse;
  const text = data.message?.content ?? "";
  if (!text.trim()) {
    throw new Error(`Ollama returned an empty completion (model=${args.model})`);
  }
  return text;
}

/** Attempts for a request that died in TRANSPORT — see postWithRetry. */
const TRANSPORT_ATTEMPTS = 3;

/**
 * POST to Ollama, retrying only a request that never produced an answer.
 *
 * The local runner is killed mid-request under memory pressure, and the
 * request fails as a dropped connection (`Post ".../tokenize": EOF`) or a 5xx.
 * That took down 150 of 345 failed newsroom runs — a whole cycle's work thrown
 * away because a subprocess died for a second while four desks reached for the
 * same model at once.
 *
 * Deliberately narrow. A 4xx is a bad request and will fail identically; an
 * empty or malformed completion is a CONTENT failure and still belongs to the
 * engine's own retry helpers, which can re-ask with a different prompt. Only
 * "the server never answered" is retried here, because only that is worth
 * asking again verbatim.
 */
async function postWithRetry(
  url: string,
  body: string,
  model: string,
  log?: (line: string) => void,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.status < 500 || attempt === TRANSPORT_ATTEMPTS) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err: unknown) {
      lastErr = err;
      if (attempt === TRANSPORT_ATTEMPTS) throw err;
    }
    // The runner needs a moment to come back up before it can load the model.
    const backoffMs = 1500 * attempt;
    log?.(
      `ollama: transport failure on attempt ${attempt}/${TRANSPORT_ATTEMPTS} (model=${model}): ${String(lastErr)} — retrying in ${backoffMs}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function createOllamaLlm(cfg: OllamaLlmConfig): LlmClient {
  /** Engine callers may pass `model: ""` (unset knob) — blank means "use the default". */
  function resolveModel(candidate: string | undefined): string {
    return candidate === undefined || candidate.trim() === "" ? cfg.model : candidate;
  }
  return {
    async complete({ system, prompt, model, temperature }) {
      const messages: OllamaChatMessage[] = [
        ...(system === undefined ? [] : [{ role: "system" as const, content: system }]),
        { role: "user" as const, content: prompt },
      ];
      const resolved = resolveModel(model);
      const request = {
        model: resolved,
        ...(temperature === undefined ? {} : { temperature }),
        ...(system === undefined ? {} : { system }),
        prompt,
      };
      try {
        const text = await chat({
          baseUrl: cfg.baseUrl,
          model: resolved,
          messages,
          temperature,
          format: undefined,
          numCtx: cfg.options?.numCtx,
          keepAlive: cfg.options?.keepAlive,
        });
        cfg.trace?.llm({ ...request, response: text });
        return text;
      } catch (err: unknown) {
        cfg.trace?.llm({ ...request, error: String(err) });
        throw err;
      }
    },

    async completeStructured<T>(args: {
      messages: OllamaChatMessage[];
      schema: ZodType<T>;
      schemaName: string;
      model?: string;
      temperature?: number;
    }): Promise<T> {
      const resolved = resolveModel(args.model);
      const request = {
        model: resolved,
        ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
        schemaName: args.schemaName,
        messages: args.messages,
      };
      let text: string;
      try {
        text = await chat({
          baseUrl: cfg.baseUrl,
          model: resolved,
          messages: args.messages,
          temperature: args.temperature,
          format: z.toJSONSchema(args.schema) as Record<string, unknown>,
          numCtx: cfg.options?.numCtx,
          keepAlive: cfg.options?.keepAlive,
        });
      } catch (err: unknown) {
        cfg.trace?.llm({ ...request, error: String(err) });
        throw err;
      }
      cfg.trace?.llm({ ...request, response: text });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `Ollama structured response was not valid JSON: ${text.slice(0, 200)}`,
        );
      }
      return args.schema.parse(parsed);
    },
  };
}
