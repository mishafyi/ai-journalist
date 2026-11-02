/**
 * Parity check for firecrawl-search.ts — proves the reference `SearchClient`
 * SHAPE works against a LIVE Firecrawl host, and that `searchDefaults`
 * actually reaches the wire:
 *
 *   npx tsx clients/firecrawl-search.checks.ts
 *
 * This makes a REAL Firecrawl call. It is ENVIRONMENT-tolerant by design: with
 * no `FIRECRAWL_API_URL` it prints a SKIP line and exits 0 — CI has no host,
 * and the check's job is to prove the client shape when a host is present, not
 * to gate the task on a flaky network call. Named *.checks.ts so vitest's
 * `**​/*.test.ts` CI glob never picks it up (it runs via the `test:checks`
 * find-loop instead).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFirecrawlSearch, createPacer } from "./firecrawl-search";

/** Pure, hostless, and therefore ALWAYS run — the pacer is the one piece of
 *  logic here that a missing FIRECRAWL_API_URL must not skip past. */
async function checkPacer(): Promise<number> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const gap = 60;
  const pace = createPacer(gap);
  const started = Date.now();
  await pace();
  const first = Date.now() - started;
  await pace();
  const second = Date.now() - started;
  ok("first call does not wait", first < gap, `waited ${first}ms`);
  ok("second call waits a full gap", second >= gap, `elapsed ${second}ms`);

  // Reserved synchronously: three parallel callers must land on three
  // DIFFERENT slots, not all wait one gap and then race the backend together.
  const parallel = createPacer(gap);
  const t0 = Date.now();
  const elapsed = await Promise.all(
    [0, 1, 2].map(async () => {
      await parallel();
      return Date.now() - t0;
    }),
  );
  const spread = Math.max(...elapsed);
  ok("parallel callers are spaced, not batched", spread >= gap * 2, `elapsed=${JSON.stringify(elapsed)}`);

  ok("zero interval disables pacing", await (async () => {
    const none = createPacer(0);
    const t = Date.now();
    await none();
    await none();
    return Date.now() - t < gap;
  })(), "a 0 interval still waited");

  return failures;
}

/** Hostless: the real SDK against a local server, so what reaches the wire and
 *  what a publisher's refusal becomes are checked without a Firecrawl host. */
async function checkScrapeRequests(): Promise<number> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };
  const LINKED = "Body with [a link](https://x.example/a).";
  const bodies: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push({ path: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      const refused = String(body.url).includes("blocked");
      res.end(JSON.stringify(req.url === "/v2/scrape"
        ? { success: true, data: { markdown: refused ? "Access Denied" : LINKED, metadata: { statusCode: refused ? 403 : 200 } } }
        : { success: true, data: { web: [
            { url: "https://ok.example/a", title: "OK", markdown: LINKED, metadata: { statusCode: 200 } },
            { url: "https://blocked.example/a", title: "No", description: "the snippet", markdown: "Access Denied", metadata: { statusCode: 403 } },
          ] } }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = createFirecrawlSearch({ apiKey: "k", apiUrl, proxy: "basic" });
    const page = await client.scrape?.("https://ok.example/a");
    const sent = bodies.at(-1)?.body ?? {};
    ok("scrape keeps the page's links (the primary chase reads them)", page === LINKED, String(page));
    ok("scrape sends the configured proxy", sent.proxy === "basic", JSON.stringify(sent));
    ok("scrape asks for main content only", sent.onlyMainContent === true, JSON.stringify(sent));
    ok("scrape excludes navigation, banner and footer by ARIA role",
      JSON.stringify(sent.excludeTags) === JSON.stringify(["[role=navigation]", "[role=banner]", "[role=contentinfo]"]),
      JSON.stringify(sent));

    const refusal = await client.scrape?.("https://blocked.example/a").then(
      (body) => ({ body }),
      (err: unknown) => ({ err: err as { name?: string; status?: number; url?: string; message?: string } }),
    );
    const err = refusal !== undefined && "err" in refusal ? refusal.err : undefined;
    ok("a page answering HTTP 403 throws ScrapeRefusedError instead of returning its text",
      err?.name === "ScrapeRefusedError", JSON.stringify(refusal));
    ok("the refusal carries the status and the URL",
      err?.status === 403 && err?.url === "https://blocked.example/a" && String(err?.message).includes("HTTP 403"),
      JSON.stringify(err));

    await createFirecrawlSearch({ apiKey: "k", apiUrl }).scrape?.("https://ok.example/b");
    ok("no proxy option leaves Firecrawl's own default in place",
      !("proxy" in (bodies.at(-1)?.body ?? {})), JSON.stringify(bodies.at(-1)?.body));

    const hits = await client.search("q", { limit: 2, scrape: true } as { limit: number });
    const options = (bodies.at(-1)?.body.scrapeOptions ?? {}) as Record<string, unknown>;
    ok("search scrapes with the same options",
      options.proxy === "basic" && options.onlyMainContent === true && Array.isArray(options.excludeTags),
      JSON.stringify(options));
    ok("a searched page that answered 403 has no content, only its snippet",
      hits[1]?.content === undefined && hits[1]?.snippet === "the snippet", JSON.stringify(hits[1]));
    ok("a searched page that answered 200 keeps its content", hits[0]?.content === LINKED, JSON.stringify(hits[0]));
  } finally {
    server.closeAllConnections();
    server.close();
  }
  return failures;
}

async function main(): Promise<void> {
  const hostlessFailures = (await checkPacer()) + (await checkScrapeRequests());
  if (hostlessFailures) {
    process.stdout.write(`\n${hostlessFailures} FAILED\n`);
    process.exit(1);
  }

  if (!process.env.FIRECRAWL_API_URL) {
    process.stdout.write("SKIP firecrawl parity — FIRECRAWL_API_URL not set\n");
    return;
  }

  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) {
      process.stdout.write(`PASS ${name}\n`);
    } else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  // searchDefaults.scrape must reach the wire. "at least one" (not "every")
  // result carrying content — "every result" would flake on real antibot
  // scrape failures; this only needs to prove the default landed.
  const client = createFirecrawlSearch({ searchDefaults: { scrape: true } });
  const results = await client.search("AI regulation news", { limit: 2 });

  ok(
    "results respect the limit",
    results.length <= 2,
    `got ${results.length}`,
  );
  ok(
    "at least one result has non-empty content (searchDefaults.scrape reached the wire)",
    results.some((r) => typeof r.content === "string" && r.content.length > 0),
    `contents=${JSON.stringify(results.map((r) => r.content?.length ?? 0))}`,
  );

  process.stdout.write(failures ? `\n${failures} FAILED\n` : `\nALL passed\n`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  // Unexpected failure — surface it; do not mask a real bug as SKIP.
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
