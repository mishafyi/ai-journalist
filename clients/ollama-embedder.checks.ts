/**
 * Offline checks for ollama-embedder.ts — MOCKED fetch (no live Ollama).
 *
 *   npx tsx clients/ollama-embedder.checks.ts
 */
import { createOllamaEmbedder } from "./ollama-embedder";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const bodies: { url: string; body: { model?: string; input?: string[] } }[] = [];
  let nextEmbeddings: number[][] = [[0.1, 0.2], [0.3, 0.4]];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ embeddings: nextEmbeddings }), { status: 200 });
  }) as typeof fetch;

  try {
    const embedder = createOllamaEmbedder({ host: "http://mock:11434", model: "embeddinggemma" });
    const vecs = await embedder.embed(["headline one", "headline two"]);
    ok("returns one vector per input", vecs.length === 2 && vecs[1][1] === 0.4, JSON.stringify(vecs));
    ok(
      "hits /api/embed with model + input array",
      bodies[0]?.url.includes("/api/embed") &&
        bodies[0]?.body.model === "embeddinggemma" &&
        Array.isArray(bodies[0]?.body.input) &&
        bodies[0]?.body.input?.length === 2,
      JSON.stringify(bodies[0]),
    );
    ok("empty input short-circuits with no backend call",
      (await embedder.embed([])).length === 0 && bodies.length === 1,
      `calls=${bodies.length}`);
    nextEmbeddings = [[0.1, 0.2]]; // 1 vector for 2 inputs
    let threw = false;
    try {
      await embedder.embed(["a", "b"]);
    } catch {
      threw = true;
    }
    ok("vector-count mismatch throws with context", threw, "resolved on mismatch");
  } finally {
    globalThis.fetch = realFetch;
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("ollama-embedder checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`ollama-embedder.checks failed: ${String(err)}\n`);
  process.exit(1);
});
