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
 *   5. `cfg.options.numCtx`/`keepAlive` forward into BOTH call sites' request
 *      (`options.num_ctx`, top-level `keep_alive`); omitted keys are sent
 *      ABSENT so the server's own env config stays authoritative.
 */
import { z } from "zod";
import { createOllamaLlm } from "./ollama-llm";

interface CapturedRequest {
  model: string;
  format?: unknown;
  options?: { temperature?: number; num_ctx?: number };
  keep_alive?: string;
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

    nextContent = "hello";
    const withOptions = createOllamaLlm({
      baseUrl: "http://mock:11434",
      model: "default-model",
      options: { numCtx: 32768, keepAlive: "30m" },
    });
    await withOptions.complete({ prompt: "p" });
    const completeCap = captured[captured.length - 1];
    ok(
      "numCtx/keepAlive forward on complete()",
      completeCap?.options?.num_ctx === 32768 && completeCap?.keep_alive === "30m",
      `options=${JSON.stringify(completeCap?.options)} keep_alive=${JSON.stringify(completeCap?.keep_alive)}`,
    );

    nextContent = JSON.stringify({ headline: "h2" });
    await withOptions.completeStructured({
      messages: [{ role: "user", content: "u" }],
      schema: z.object({ headline: z.string() }),
      schemaName: "test",
    });
    const structuredCap = captured[captured.length - 1];
    ok(
      "numCtx/keepAlive forward on completeStructured()",
      structuredCap?.options?.num_ctx === 32768 && structuredCap?.keep_alive === "30m",
      `options=${JSON.stringify(structuredCap?.options)} keep_alive=${JSON.stringify(structuredCap?.keep_alive)}`,
    );

    ok(
      "omitted numCtx/keepAlive send neither key (server env stays authoritative)",
      !("num_ctx" in (captured[0]?.options ?? {})) && !("keep_alive" in (captured[0] ?? {})),
      `options=${JSON.stringify(captured[0]?.options)} top-level keys=${Object.keys(captured[0] ?? {}).join(",")}`,
    );
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
