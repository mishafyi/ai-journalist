/** Embedder retry behaviour — run: npx tsx clients/ollama-embedder.checks.ts */
import { createOllamaEmbedder, isTransient } from "./ollama-embedder";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  // The exact string that killed 197 newsroom runs. It is a GO error arriving
  // as HTTP 400, which is why status-based retries never caught it.
  const REAL = new Error('Post "http://127.0.0.1:53284/tokenize": EOF');
  ok("the tokenize EOF that killed 197 runs is classed transient", isTransient(REAL), REAL.message);
  ok("socket-level failures are transient",
    isTransient(new Error("fetch failed")) && isTransient(new Error("ECONNREFUSED")), "");
  // A wrong model name will fail identically however many times it is asked.
  ok("a genuine bad request is NOT retried",
    !isTransient(new Error('model "nope" not found, try pulling it first')), "");
  ok("a short vector list is a content failure, not transport",
    !isTransient(new Error("ollama embed returned 2 vectors for 3 inputs")), "");

  const realFetch = globalThis.fetch;
  const vectors = (n: number): Response =>
    new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => [0.1, 0.2]) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  // The race the desk has to survive: the runner is evicted mid-embed.
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    if (calls < 3) throw new Error('Post "http://127.0.0.1:53284/tokenize": EOF');
    return vectors(2);
  }) as typeof fetch;
  const logs: string[] = [];
  const embedder = createOllamaEmbedder({
    host: "http://x", model: "embeddinggemma", log: (l) => logs.push(l),
  });
  const out = await embedder.embed(["a", "b"]);
  ok("an evicted runner is retried and the run survives",
    out.length === 2 && calls === 3, `len=${out.length} calls=${calls}`);
  ok("the retry announces itself rather than swallowing the failure",
    logs.length === 2 && logs[0].includes("transport failure"), JSON.stringify(logs));

  // Empty input never touches the network.
  calls = 0;
  ok("no request is made for an empty input list",
    (await embedder.embed([])).length === 0 && calls === 0, `calls=${calls}`);

  // A runner that never returns must raise, not hang or return junk.
  calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    throw new Error('Post "http://127.0.0.1:1/tokenize": EOF');
  }) as typeof fetch;
  let threw = false;
  try {
    await embedder.embed(["a"]);
  } catch {
    threw = true;
  }
  ok("a runner that never comes back raises after the last attempt",
    threw && calls === 3, `threw=${threw} calls=${calls}`);

  // A mismatched vector count is surfaced immediately, not retried away.
  // Hermetic on purpose: its own counter and its own embedder. Sharing the
  // module-level `calls`/fetch across cases let an earlier mock's state leak
  // in and this assertion passed on the mock rather than on the code.
  {
    let short = 0;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const solo = createOllamaEmbedder({ host: "http://x", model: "m", log: () => { short += 1; } });
    let mismatch = "";
    try {
      await solo.embed(["a", "b"]);
    } catch (e: unknown) {
      mismatch = e instanceof Error ? e.message : String(e);
    }
    ok("a short vector list fails immediately, with a countable message",
      /returned 1 vectors for 2 inputs/.test(mismatch) && short === 0,
      `msg=${mismatch} retries=${short}`);
  }

  globalThis.fetch = realFetch;
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
