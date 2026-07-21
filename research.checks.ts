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
  extractEvidence,
  createExtractiveResearch,
} from "./research";
import type { LlmClient, SearchClient, SearchResult } from "./ports";

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

// extractEvidence / createExtractiveResearch — chunked extraction (Task 5).
// Byte-lock: the extraction system prompt moved UNCHANGED from the live-tested
// examples/run-politics.ts runner.
const EXTRACT_SYSTEM =
  "You extract evidence for a news article. From the page text, list every concrete fact, statistic, date, named person or institution, and direct quote (verbatim, in quotation marks, with who said it) relevant to the topic. Dense bullet points only, no commentary. If nothing is relevant, reply exactly: NONE";

function fakeLlm(
  reply: (prompt: string) => string,
): LlmClient & { prompts: string[]; systems: string[] } {
  const prompts: string[] = [];
  const systems: string[] = [];
  return {
    prompts,
    systems,
    async complete(args: { system?: string; prompt: string }): Promise<string> {
      systems.push(args.system ?? "");
      prompts.push(args.prompt);
      return reply(args.prompt);
    },
    async completeStructured(): Promise<never> {
      throw new Error("completeStructured is not used by extraction");
    },
  };
}

{
  // chunk math (30k → 2 parts at 24k), NONE filtering, failed-scrape snippet
  // fallback, SOURCE-block concatenation, sources = contributing pages.
  const sc: SearchClient = {
    async search(): Promise<SearchResult[]> {
      return [
        { title: "Long", url: "https://apnews.com/long", snippet: "long snippet" },
        { title: "Broken", url: "https://cnbc.com/broken", snippet: "broken snippet" },
      ];
    },
    async scrape(url: string): Promise<string> {
      if (url.includes("broken")) throw new Error("403 blocked");
      return "w".repeat(30_000);
    },
  };
  const llm = fakeLlm((p) => (p.includes("part 2/2") ? "NONE" : "- fact: 42"));
  const logs: string[] = [];
  const research = createExtractiveResearch({
    llm, search: sc, pagesPerTopic: 3, chunkChars: 24_000, maxChunksPerPage: 4,
    minContentChars: 400, log: (l) => logs.push(l),
  });
  const { block, sources } = await research("chunk math topic");
  ok("30k page splits into exactly 2 extraction calls (24k chunks)",
    llm.prompts.length === 2 &&
      llm.prompts[0].includes("(part 1/2)") && llm.prompts[1].includes("(part 2/2)"),
    JSON.stringify(llm.prompts.map((p) => p.slice(0, 70))));
  ok("extraction system prompt is byte-locked",
    llm.systems.length > 0 && llm.systems.every((s) => s === EXTRACT_SYSTEM),
    llm.systems[0] ?? "no system captured");
  ok("NONE chunks are filtered out of the SOURCE block",
    block.includes("- fact: 42") && !block.includes("NONE"), block);
  ok("block concatenates SOURCE <title> (<url>): sections",
    block.includes("SOURCE Long (https://apnews.com/long):\n- fact: 42"), block);
  ok("failed scrape degrades to the snippet line (logged)",
    block.includes("- Broken: broken snippet") && logs.some((l) => l.includes("FAILED")),
    `${block} | ${logs.join("|")}`);
  ok("sources = contributing pages, snippet-fallback hit included",
    JSON.stringify(sources) === JSON.stringify([
      { title: "Long", url: "https://apnews.com/long" },
      { title: "Broken", url: "https://cnbc.com/broken" },
    ]), JSON.stringify(sources));
}
{
  // minContentChars floor: a SUCCESSFUL scrape below the floor degrades to the
  // snippet line exactly like a failed scrape — no extraction calls burned.
  const sc: SearchClient = {
    async search(): Promise<SearchResult[]> {
      return [{ title: "Thin", url: "https://ft.com/thin", snippet: "thin snippet" }];
    },
    async scrape(): Promise<string> { return "only one hundred chars? no."; },
  };
  const llm = fakeLlm(() => "- must never be asked");
  const research = createExtractiveResearch({ llm, search: sc, pagesPerTopic: 3,
    chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400 });
  const { block, sources } = await research("thin topic");
  ok("sub-minContentChars scrape degrades to the snippet line (no LLM calls)",
    block === "- Thin: thin snippet" && llm.prompts.length === 0 && sources.length === 1,
    `${block} | prompts=${llm.prompts.length}`);
}
{
  // reuse rule: hit.content ?? scrape — pre-scraped hits never re-hit the backend
  let scrapes = 0;
  const sc: SearchClient = {
    async search(): Promise<SearchResult[]> {
      return [{ title: "Pre", url: "https://reuters.com/pre", snippet: "s",
        content: "pre-scraped body ".repeat(30) }];
    },
    async scrape(): Promise<string> { scrapes += 1; return "never used"; },
  };
  const llm = fakeLlm(() => "- pre fact");
  const research = createExtractiveResearch({ llm, search: sc, pagesPerTopic: 3,
    chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400 });
  const { block } = await research("reuse topic");
  ok("pre-scraped hit.content is reused — scrape() never called",
    scrapes === 0 && block.includes("- pre fact"), `scrapes=${scrapes} | ${block}`);
}
{
  // no scrape() port at all: content-less hits degrade to snippets, ONE log
  // line per topic (not per hit)
  const sc: SearchClient = {
    async search(): Promise<SearchResult[]> {
      return [
        { title: "A", url: "https://a.example/1", snippet: "sa" },
        { title: "B", url: "https://b.example/2", snippet: "sb" },
      ];
    },
  };
  const llm = fakeLlm(() => "unused");
  const logs: string[] = [];
  const research = createExtractiveResearch({ llm, search: sc, pagesPerTopic: 3,
    chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400,
    log: (l) => logs.push(l) });
  const { block, sources } = await research("no scrape topic");
  ok("no scrape() port: snippet fallback for every content-less hit, logged once",
    block === "- A: sa\n\n- B: sb" && sources.length === 2 &&
      logs.filter((l) => l.includes("no scrape")).length === 1,
    `${block} | logs=${JSON.stringify(logs)}`);
}
{
  // all-NONE page contributes nothing: empty block, no source row
  const sc: SearchClient = {
    async search(): Promise<SearchResult[]> {
      return [{ title: "Irrelevant", url: "https://x.example/i", snippet: "s",
        content: "z".repeat(500) }];
    },
  };
  const llm = fakeLlm(() => "NONE");
  const research = createExtractiveResearch({ llm, search: sc, pagesPerTopic: 3,
    chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400 });
  const { block, sources } = await research("nothing relevant");
  ok("all-NONE page contributes nothing (empty block, no source row)",
    block === "" && sources.length === 0, JSON.stringify({ block, sources }));
}
{
  // extractEvidence standalone — Phase 2 feeds RESOLVED urls, no SearchClient
  const llm = fakeLlm((p) => (p.includes("part 1/1") ? "- solo fact" : "NONE"));
  const parts = await extractEvidence({ llm, topic: "t",
    page: { url: "https://u.example/p", title: "T", content: "abc".repeat(200) },
    chunkChars: 24_000, maxChunksPerPage: 4 });
  ok("extractEvidence standalone: single chunk → trimmed parts, no search dep",
    JSON.stringify(parts) === JSON.stringify(["- solo fact"]) && llm.prompts.length === 1,
    JSON.stringify(parts));
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
