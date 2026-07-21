/**
 * Offline checks for research.ts — pure query hygiene first (Task 1);
 * later tasks append tier/throttle/gather/extract sections.
 *
 *   npx tsx research.checks.ts
 */
import {
  sanitizeQuery,
  relaxQuery,
  hostOf,
  sourceTier,
  isBlockedHost,
  DEFAULT_BLOCKED_HOSTS,
  createResearchStack,
} from "./research";
import type { SearchClient, SearchResult } from "./ports";

let failures = 0;
const ok = (name: string, cond: boolean, detail: string): void => {
  if (cond) process.stdout.write(`PASS ${name}\n`);
  else {
    failures += 1;
    process.stdout.write(`FAIL ${name} — ${detail}\n`);
  }
};

// Async main from the start (matches clients/ollama-llm.checks.ts exactly) —
// later tasks append await-ing sections inside it without restructuring.
async function main(): Promise<void> {

// sanitizeQuery — the single choke point every search routes through.
ok(
  "typographic quotes are normalized",
  sanitizeQuery("„EU tariff" + "”" + " impact") === '"EU tariff" impact',
  String(sanitizeQuery("„EU tariff” impact")),
);
ok(
  "ideation-scaffold line with empty slot is rejected",
  sanitizeQuery("reasons: psychological - ") === null,
  String(sanitizeQuery("reasons: psychological - ")),
);
ok("sub-8-char query is rejected", sanitizeQuery("details") === null,
  String(sanitizeQuery("details")));
ok("trailing-dash empty slot is rejected", sanitizeQuery("history: EU -") === null,
  String(sanitizeQuery("history: EU -")));
ok(
  "leading interrogatives are stripped (dictionary-junk guard)",
  sanitizeQuery("why does the EU fine platforms?") === "the EU fine platforms",
  String(sanitizeQuery("why does the EU fine platforms?")),
);
ok(
  "stripping is skipped when it would fall under the 8-char floor",
  sanitizeQuery("why tariffs?") === "why tariffs?",
  String(sanitizeQuery("why tariffs?")),
);

// relaxQuery — the empty-result recovery form.
ok(
  "site:/intitle:/negations/quotes are stripped",
  relaxQuery('site:reuters.com intitle:tariff -"opinion" "EU trade"') ===
    "tariff EU trade",
  relaxQuery('site:reuters.com intitle:tariff -"opinion" "EU trade"'),
);

// hostOf / sourceTier — source tiering, skip-hosts reused from news.ts (Task 2).
ok("hostOf strips www and survives junk", hostOf("https://www.reuters.com/x") === "reuters.com" && hostOf("not a url") === "",
  `${hostOf("https://www.reuters.com/x")} | ${hostOf("not a url")}`);
ok("wire outlet is tier 1", sourceTier("https://apnews.com/article/x") === 1,
  String(sourceTier("https://apnews.com/article/x")));
ok(".gov is tier 1", sourceTier("https://ftc.gov/press/x") === 1,
  String(sourceTier("https://ftc.gov/press/x")));
ok("content-farm class pattern is tier 3",
  sourceTier("https://bestof-insightshub.net/top10") === 3,
  String(sourceTier("https://bestof-insightshub.net/top10")));
ok("unknown host is tier 2", sourceTier("https://example-blog.io/post") === 2,
  String(sourceTier("https://example-blog.io/post")));
ok("skip-host reuse: news.ts matcher covers subdomains and .mil",
  isBlockedHost("cn.wsj.com", DEFAULT_BLOCKED_HOSTS) &&
    isBlockedHost("af.mil", DEFAULT_BLOCKED_HOSTS) &&
    !isBlockedHost("theguardian.com", DEFAULT_BLOCKED_HOSTS),
  "wsj-subdomain/.mil/guardian triple");

// throttledSearch — gap gate, relaxed empty-retry, circuit breaker (Task 3).
function fakeSearch(script: SearchResult[][]): SearchClient & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(q: string): Promise<SearchResult[]> {
      queries.push(q);
      return script.shift() ?? [];
    },
  } as SearchClient & { queries: string[] };
}
const HIT: SearchResult = { title: "t", url: "https://apnews.com/a/b", snippet: "s" };
const instant = { sleep: async (): Promise<void> => {}, now: (): number => 0 };

{
  // empty first attempt → retried with the RELAXED form
  const sc = fakeSearch([[], [HIT]]);
  const stack = createResearchStack({ search: sc, ...instant });
  const r = await stack.throttledSearch('site:apnews.com "EU tariff ruling"', "check");
  ok("empty retry re-runs the relaxed form",
    r.length === 1 && sc.queries[1] === "EU tariff ruling",
    JSON.stringify(sc.queries));
}
{
  // scaffold query is skipped without any search call
  const sc = fakeSearch([[HIT]]);
  const stack = createResearchStack({ search: sc, ...instant });
  const r = await stack.throttledSearch("reasons: psychological - ", "check");
  ok("scaffold query short-circuits to []", r.length === 0 && sc.queries.length === 0,
    JSON.stringify(sc.queries));
}
{
  // breaker: after 8 all-empty searches, further calls short-circuit.
  // NOTE the arithmetic: an exhausted throttledSearch issues 1 + searchEmptyRetries
  // = 3 search() calls (empty retries re-run the SAME query when the relaxed form
  // is identical — suspected-block semantics, zerog parity). So 8 exhausted calls
  // = 24 fake-search calls before the breaker opens.
  const script: SearchResult[][] = []; // every shift() → undefined → []
  const sc = fakeSearch(script);
  const stack = createResearchStack({ search: sc, ...instant });
  for (let i = 0; i < 8; i++) await stack.throttledSearch(`dead query ${i} xxxx`, "check");
  const callsBefore = sc.queries.length; // 8 × 3 attempts = 24
  await stack.throttledSearch("one more dead query", "check");
  ok("breaker opens after 8 consecutive empties (no further search calls)",
    sc.queries.length === callsBefore,
    `calls before=${callsBefore} after=${sc.queries.length}`);
  stack.resetRunState();
  script.push([HIT]); // fresh backend after reset — first attempt hits
  await stack.throttledSearch("fresh after reset xxxx", "check");
  ok("resetRunState closes the breaker (hit on first attempt = exactly one call)",
    sc.queries.length === callsBefore + 1,
    String(sc.queries.length));
}

// gatherResearch — tier-ranked block, primary chase, dropped-URL pool (Task 4).
{
  const results: SearchResult[] = [
    { title: "AP", url: "https://apnews.com/a/b", snippet: "s1", content: "wire body ".repeat(60) },
    { title: "Blog", url: "https://some-blog.io/p", snippet: "s2",
      content: `retold from https://apnews.com/orig/story with commentary ${"x".repeat(500)}` },
    { title: "Farm", url: "https://top10-insightshub.net/x", snippet: "s3", content: "junk ".repeat(120) },
  ];
  const sc = {
    async search(): Promise<SearchResult[]> { return results; },
    async scrape(url: string): Promise<string> { return `PRIMARY BODY ${"y".repeat(600)} (${url})`; },
  } as SearchClient;
  const stack = createResearchStack({ search: sc, ...instant });
  const { block, sources } = await stack.gatherResearch("EU tariff ruling coverage");
  ok("tier-1 outranks tier-3 in block order",
    block.indexOf("apnews.com/a/b") < block.indexOf("top10-insightshub.net"), "ordering");
  ok("low-authority block carries the suspicion label",
    block.includes("LOW-AUTHORITY"), block.slice(0, 200));
  ok("primary chase fetched the tier-1 original",
    block.includes("PRIMARY SOURCE (chased from some-blog.io)") &&
      block.includes("apnews.com/orig/story"), "chase");
  ok("sources list includes chased + ranked", sources.length === 4,
    String(sources.length));
}
{
  // skip-hosted chase candidate lands in the dropped pool instead
  const sc2 = {
    async search(): Promise<SearchResult[]> {
      return [{ title: "B", url: "https://blog.io/p", snippet: "s",
        content: `see https://www.reuters.com/world/x ${"z".repeat(500)}` }];
    },
    async scrape(): Promise<string> { return ""; },
  } as SearchClient;
  const stack2 = createResearchStack({ search: sc2, ...instant });
  await stack2.gatherResearch("anything long enough");
  ok("antibot tier-1 chase is pooled, not scraped",
    stack2.drainDroppedUrls(5).some((u) => u.includes("reuters.com")), "pool");
}
{
  // ranked-body cap, snippet fallback for unscraped hits, composition artifact
  const artifacts: string[] = [];
  const sc3 = {
    async search(): Promise<SearchResult[]> {
      return [
        { title: "Huge", url: "https://apnews.com/big/doc", snippet: "s",
          content: "x".repeat(70_000) },
        { title: "Unscraped", url: "https://cnbc.com/only/snippet", snippet: "the snippet body" },
      ];
    },
  } as SearchClient;
  const stack3 = createResearchStack({ search: sc3, ...instant,
    recordArtifact: (label) => { artifacts.push(label); } });
  const { block } = await stack3.gatherResearch("cap and fallback check");
  ok("ranked body is capped with the truncation marker",
    block.includes("[... truncated: document continues]") && block.length < 75_000,
    `len=${block.length}`);
  ok("unscraped hit falls back to its snippet",
    block.includes("the snippet body"), "snippet fallback");
  ok("a research-composition artifact is recorded",
    artifacts.some((l) => l.toLowerCase().includes("research")), artifacts.join("|"));
}
{
  // retryThin drains the pool; facade hardens + memoizes
  let scrapes = 0;
  const sc4 = {
    async search(): Promise<SearchResult[]> {
      return [{ title: "B", url: "https://blog.io/p", snippet: "s",
        content: `see https://www.reuters.com/world/deep/x ${"z".repeat(500)}` }];
    },
    async scrape(url: string): Promise<string> { scrapes += 1; return `BACKFILL ${"b".repeat(600)} ${url}`; },
  } as SearchClient;
  const stack4 = createResearchStack({ search: sc4, ...instant });
  await stack4.gatherResearch("pool feeder topic here");
  const thin = await stack4.retryThin("Thin Section");
  ok("retryThin scrapes pooled URLs into ### Source blocks",
    thin.includes("### Source") && thin.includes("reuters.com"), thin.slice(0, 120));
  ok("retryThin is empty when the pool is dry",
    (await stack4.retryThin("again")) === "", "second drain");

  const facade = stack4.asSearchClient();
  const facadeHits = await facade.search("reasons: psychological - ", { limit: 3 });
  ok("facade sanitizes: scaffold query returns [] without a backend call",
    facadeHits.length === 0, String(facadeHits.length));
  const before = scrapes;
  await facade.scrape?.("https://memo.example/page");
  await facade.scrape?.("https://memo.example/page");
  ok("facade scrape is memoized (second call = no backend hit)",
    scrapes === before + 1, `scrapes=${scrapes - before}`);
}

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("research checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`research.checks failed: ${String(err)}\n`);
  process.exit(1);
});
