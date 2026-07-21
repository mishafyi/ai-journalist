/**
 * Offline checks for ollama-llm.ts — prove the `LlmClient` shape against a
 * MOCKED `fetch` (no live Ollama needed, CI-safe, deterministic):
 *
 *   npx tsx clients/ollama-llm.checks.ts
 *
 * Locked behaviours:
 *   1. A blank per-call `model` ("" / undefined) resolves to the configured
 *      default — engine callers pass `model: ""` for an unset knob, and Ollama
 *      400s on an empty model (the exact regression this pins).
 *   2. An explicit per-call `model` passes through untouched.
 *   3. `completeStructured` sends the JSON Schema as `format` and returns the
 *      Zod-validated object.
 *   4. An empty completion throws (retryable) instead of returning "".
 */
import { z } from "zod";
import { createOllamaLlm } from "./ollama-llm";

interface CapturedRequest {
  model: string;
  format?: unknown;
}

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) {
      process.stdout.write(`PASS ${name}\n`);
    } else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const captured: CapturedRequest[] = [];
  let nextContent = "hello";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest;
    captured.push(body);
    return new Response(JSON.stringify({ message: { content: nextContent } }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    const llm = createOllamaLlm({ baseUrl: "http://mock:11434", model: "default-model" });

    await llm.complete({ prompt: "p", model: "" });
    ok(
      "blank model resolves to the configured default",
      captured[0]?.model === "default-model",
      `sent model=${JSON.stringify(captured[0]?.model)}`,
    );

    await llm.complete({ prompt: "p", model: "explicit:tag" });
    ok(
      "explicit model passes through",
      captured[1]?.model === "explicit:tag",
      `sent model=${JSON.stringify(captured[1]?.model)}`,
    );

    nextContent = JSON.stringify({ headline: "h" });
    const structured = await llm.completeStructured({
      messages: [{ role: "user", content: "u" }],
      schema: z.object({ headline: z.string() }),
      schemaName: "test",
    });
    ok(
      "structured call sends a JSON-Schema format and returns the parsed object",
      structured.headline === "h" &&
        typeof captured[2]?.format === "object" &&
        captured[2]?.format !== null,
      `format=${JSON.stringify(captured[2]?.format)?.slice(0, 60)} parsed=${JSON.stringify(structured)}`,
    );

    nextContent = "   ";
    let threw = false;
    try {
      await llm.complete({ prompt: "p" });
    } catch {
      threw = true;
    }
    ok("empty completion throws (retryable)", threw, "resolved with blank text");
  } finally {
    globalThis.fetch = realFetch;
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("ollama-llm checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`ollama-llm.checks failed: ${String(err)}\n`);
  process.exit(1);
});
