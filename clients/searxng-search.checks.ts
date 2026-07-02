/**
 * Parity check for searxng-search.ts — proves the reference `SearchClient` SHAPE
 * works against a LIVE self-hosted SearXNG JSON API:
 *
 *   npx tsx clients/searxng-search.checks.ts
 *
 * This makes a REAL SearXNG call. It is ENVIRONMENT-tolerant by design: with no
 * `SEARXNG_URL` it prints a SKIP line and exits 0 — CI has no instance, and the
 * check's job is to prove the client shape when a host is present, not to gate the
 * task on a flaky network call. Named *.checks.ts so vitest's `**​/*.test.ts` CI
 * glob never picks it up (it runs via the `test:checks` find-loop instead).
 */
import { createSearxngSearch } from "./searxng-search";

async function main(): Promise<void> {
  if (!process.env.SEARXNG_URL) {
    process.stdout.write("SKIP searxng parity — SEARXNG_URL not set\n");
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

  // The port's headline behaviour: `search(query, {limit})` hits {baseUrl}/search
  // ?format=json and maps `results[]` → { title, url, snippet }. Assert the limit
  // is honoured and every returned hit carries the required non-empty fields.
  const client = createSearxngSearch({});
  const results = await client.search("test query", { limit: 3 });

  ok(
    "results respect the limit",
    results.length <= 3,
    `got ${results.length}`,
  );
  ok(
    "every result has a non-empty title",
    results.every((r) => typeof r.title === "string" && r.title.length > 0),
    `titles=${JSON.stringify(results.map((r) => r.title))}`,
  );
  ok(
    "every result has a non-empty url",
    results.every((r) => typeof r.url === "string" && r.url.length > 0),
    `urls=${JSON.stringify(results.map((r) => r.url))}`,
  );
  ok(
    "every result snippet is a string",
    results.every((r) => typeof r.snippet === "string"),
    `snippets=${JSON.stringify(results.map((r) => typeof r.snippet))}`,
  );

  process.stdout.write(failures ? `\n${failures} FAILED\n` : `\nALL passed\n`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  // Unexpected failure — surface it; do not mask a real bug as SKIP.
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
