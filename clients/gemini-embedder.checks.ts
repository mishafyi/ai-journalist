/** Gemini embedder batching + rotation — run: npx tsx clients/gemini-embedder.checks.ts */
import { createGeminiEmbedder } from "./gemini-embedder";

interface EmbedRequest {
  requests?: { content?: { parts?: { text?: string }[] } }[];
  content?: { parts?: { text?: string }[] };
  outputDimensionality?: number;
}

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const realFetch = globalThis.fetch;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  /** The endpoint's shape: one {values} per input, in order. */
  const vectors = (texts: string[]): Response =>
    json({ embeddings: texts.map((t) => ({ values: [t.length, 1, 2] })) });
  /** Every text in one request, whatever wrapper the SDK chose. */
  const textsOf = (body: EmbedRequest): string[] =>
    body.requests !== undefined
      ? body.requests.map((r) => r.content?.parts?.[0]?.text ?? "")
      : [body.content?.parts?.[0]?.text ?? ""];

  const spy = (): { sizes: number[]; bodies: EmbedRequest[] } => {
    const seen = { sizes: [] as number[], bodies: [] as EmbedRequest[] };
    globalThis.fetch = (async (_u: unknown, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as EmbedRequest;
      seen.bodies.push(body);
      const texts = textsOf(body);
      seen.sizes.push(texts.length);
      return vectors(texts);
    }) as typeof fetch;
    return seen;
  };

  const keys = ["k1", "k2", "k3"];

  // ── Batching is the whole point: 1,000+ index headlines one per request
  // would spend an eighth of the day's 8,000-request budget on a single run.
  {
    const seen = spy();
    const embedder = createGeminiEmbedder({ apiKeys: keys });
    const out = await embedder.embed(Array.from({ length: 250 }, (_, i) => "x".repeat(i + 1)));
    ok("250 texts go out as 100/100/50, not 250 requests",
      seen.sizes.length === 3 && seen.sizes[0] === 100 && seen.sizes[1] === 100 && seen.sizes[2] === 50,
      `sizes=${JSON.stringify(seen.sizes)}`);
    ok("vectors come back in order, one per input",
      out.length === 250 && out[0][0] === 1 && out[99][0] === 100 && out[249][0] === 250,
      `len=${out.length} first=${out[0]?.[0]} last=${out[249]?.[0]}`);
  }

  // ── 100 is the API's hard ceiling: 250 in one request answers
  // `400 * BatchEmbedContentsRequest.requests: at most 100 requests can be in
  // one batch`, so a chunk over it is a bug we would ship, not a retryable.
  {
    const seen = spy();
    await createGeminiEmbedder({ apiKeys: keys }).embed(Array.from({ length: 100 }, (_, i) => `t${i}`));
    ok("a batch exactly at the ceiling stays one request",
      seen.sizes.length === 1 && seen.sizes[0] === 100, `sizes=${JSON.stringify(seen.sizes)}`);
    ok("no request may exceed the API's 100-content ceiling",
      seen.sizes.every((n) => n <= 100), `sizes=${JSON.stringify(seen.sizes)}`);
  }

  // ── The silent-fold trap. Handing the SDK a string[] returns ONE vector for
  // the whole array with no error (measured: 250 texts → 1 embedding), which
  // would have shipped as "matching quietly stopped working".
  {
    const seen = spy();
    await createGeminiEmbedder({ apiKeys: keys }).embed(["alpha", "beta", "gamma"]);
    ok("each text is its own Content, never folded into one",
      textsOf(seen.bodies[0]).join("|") === "alpha|beta|gamma",
      JSON.stringify(seen.bodies[0]).slice(0, 200));
  }

  // ── Empty input must not touch the network.
  {
    const seen = spy();
    const out = await createGeminiEmbedder({ apiKeys: keys }).embed([]);
    ok("no request is made for an empty input list",
      out.length === 0 && seen.sizes.length === 0, `requests=${seen.sizes.length}`);
  }

  // ── A rate limit is the ring's problem: rotate to the next key, survive.
  {
    let calls = 0;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return json({ error: { code: 429, message: "RESOURCE_EXHAUSTED", status: "RESOURCE_EXHAUSTED" } }, 429);
      }
      return vectors(textsOf(JSON.parse(String(init?.body ?? "{}")) as EmbedRequest));
    }) as typeof fetch;
    const logs: string[] = [];
    const out = await createGeminiEmbedder({ apiKeys: keys, log: (l) => logs.push(l) }).embed(["a", "b"]);
    ok("a 429 on one key is answered by the next key, not by failing the run",
      out.length === 2 && calls === 2, `len=${out.length} calls=${calls}`);
    ok("the rotation says so rather than swallowing it",
      logs.some((l) => l.includes("rate-limited")), JSON.stringify(logs));
  }

  // ── A short vector list is a CONTENT failure. Asking again verbatim returns
  // the same thing, so it must fail at once instead of touring the ring.
  {
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls += 1;
      return json({ embeddings: [{ values: [1, 2, 3] }] });
    }) as typeof fetch;
    let message = "";
    try {
      await createGeminiEmbedder({ apiKeys: keys }).embed(["a", "b"]);
    } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }
    ok("a short vector list fails immediately, with a countable message",
      /returned 1 vectors for 2 inputs/.test(message) && calls === 1,
      `msg=${message} calls=${calls}`);
  }

  // ── An empty vector is the same kind of failure, and must not reach
  // cosineSimilarity — which throws on a zero-length vector anyway, but from
  // three files away with nothing naming the embedder.
  {
    globalThis.fetch = (async (): Promise<Response> => json({ embeddings: [{ values: [] }] })) as typeof fetch;
    let message = "";
    try {
      await createGeminiEmbedder({ apiKeys: keys }).embed(["a"]);
    } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }
    ok("an empty vector is named here, not deep inside the matcher",
      /empty vector at index 0/.test(message), `msg=${message}`);
  }

  globalThis.fetch = realFetch;
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("gemini-embedder checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`gemini-embedder.checks failed: ${String(err)}\n`);
  process.exit(1);
});
