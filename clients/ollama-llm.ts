/**
 * `LlmClient` adapter for a local/LAN Ollama server (https://ollama.com).
 *
 * Mirrors the OpenRouter client's contract exactly: free-text `complete`,
 * grammar-constrained `completeStructured` (Ollama's `format` field takes a
 * JSON Schema and constrains decoding server-side, so the reply can't wrap the
 * data in prose), empty completions throw so the caller's retry wrapper can
 * re-ask. No internal retry — retries belong to the engine's helpers.
 */
import { z } from "zod";
import type { ZodType } from "zod";
import type { LlmClient } from "../ports";

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
  const res = await fetch(`${args.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
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
      return chat({
        baseUrl: cfg.baseUrl,
        model: resolveModel(model),
        messages,
        temperature,
        format: undefined,
        numCtx: cfg.options?.numCtx,
        keepAlive: cfg.options?.keepAlive,
      });
    },

    async completeStructured<T>(args: {
      messages: OllamaChatMessage[];
      schema: ZodType<T>;
      schemaName: string;
      model?: string;
      temperature?: number;
    }): Promise<T> {
      const text = await chat({
        baseUrl: cfg.baseUrl,
        model: resolveModel(args.model),
        messages: args.messages,
        temperature: args.temperature,
        format: z.toJSONSchema(args.schema) as Record<string, unknown>,
        numCtx: cfg.options?.numCtx,
        keepAlive: cfg.options?.keepAlive,
      });
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
