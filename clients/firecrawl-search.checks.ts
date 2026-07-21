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
import { createFirecrawlSearch } from "./firecrawl-search";

async function main(): Promise<void> {
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
