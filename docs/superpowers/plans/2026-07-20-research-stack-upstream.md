# Research Stack Upstream (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upstream zerogtalent's battle-tested research hardening (query sanitizer/relaxer, throttled search with circuit breaker, source tiering, primary-source chase, chunked full-page extraction) into the ai-journalist engine as opt-in, port-pure modules — with all defaults unchanged for existing adopters.

**Architecture:** One new engine-core module `research.ts` holding pure query/tier helpers plus two factories (`createResearchStack`, `createExtractiveResearch`) that speak ONLY the `SearchClient`/`LlmClient` ports — no SDKs, no `process.env`. Firecrawl-specific search options move into the reference client as construction-time defaults. The existing `gatherResearch` seam in `presets/default.ts` (added 2026-07-20) is the opt-in point; the preset's snippet default stays.

**Tech Stack:** TypeScript (raw-TS ESM package, Node ≥20), `p-limit` + `zod` (already deps), repo-native `*.checks.ts` test convention (standalone tsx scripts, PASS/FAIL lines, exit 1 on failure — see `clients/ollama-llm.checks.ts` for the exact style).

## Global Constraints

- **Purity guard** (`npx tsx __guard.checks.ts` must stay green): engine core reads NO `process.env` and none of the guard's banned string literals (the `owl-alpha` model id + six brand phrases — regex literals and host constants like `"wsj.com"` are NOT banned; don't "fix" non-violations). All knobs are config arguments. Only `clients/**` may touch env/SDKs.
- **Never edit an existing byte-lock** to make a change pass. New code gets NEW checks files; existing `*.checks.ts` locks stay byte-identical.
- **Defaults unchanged:** `createDefaultInternals` continues to default `gatherResearch` to the snippet block. Nothing in this plan alters behavior for an adopter who doesn't opt in.
- **No new npm dependencies** in this phase.
- **Source of truth for ported logic:** `/Users/misha/zerogtalent/services/blog/generator/generate.ts` (lines cited per task). Port the LOGIC onto the ports; drop its env reads, module-level run state, and Firecrawl SDK calls.
- **Default knob values (copied verbatim from zerogtalent — env defaults except where noted):** researchLimit 5 · primaryChaseMax 2 · primaryChaseMaxChars 60000 · chasedMinChars 500 (hard literal `md.length >= 500` at source line 1417, not an env knob) · chaseSkipHosts `wsj.com,bloomberg.com,nytimes.com,reuters.com,mckinsey.com,ft.com` (+ any `.mil`) · searchMinGapMs 3000 · searchEmptyRetries 2 · searchEmptyRetryBaseMs 10000 · searchBreakerAfter 8.
- Commands run from `/Users/misha/ai-journalist`. Full gate: `npm run build && npm run test:checks && npm run test:example`.

---

### Task 1: Query hygiene — `sanitizeQuery` / `relaxQuery`

**Files:**
- Create: `research.ts`
- Test: `research.checks.ts`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces: `sanitizeQuery(query: string): string | null`, `relaxQuery(query: string): string` — Task 3 routes every search through them.

- [ ] **Step 1: Write the failing checks**

Create `research.checks.ts`:

```ts
/**
 * Offline checks for research.ts — pure query hygiene first (Task 1);
 * later tasks append tier/throttle/gather/extract sections.
 *
 *   npx tsx research.checks.ts
 */
import { sanitizeQuery, relaxQuery } from "./research";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx research.checks.ts`
Expected: FAIL — `Cannot find module './research'` (or export error).

- [ ] **Step 3: Implement in `research.ts`**

```ts
/**
 * research.ts — the engine's hardened research stack, upstreamed from a
 * production adapter (query hygiene, source tiering, throttled search with
 * a dead-upstream breaker, primary-source chase, chunked extraction).
 * Port-pure: speaks only SearchClient/LlmClient; all knobs are arguments.
 * Everything here is OPT-IN — presets keep their cheap snippet default.
 */

const DOUBLE_QUOTES = /[„“”«»]/g;
const SINGLE_QUOTES = /[‚‘’‹›]/g;
const BOX_SCAFFOLD =
  /^\s*(?:history|scope|reasons|impacts|countermoves|futures)\s*:[^-]{0,60}-\s*/i;
const INTERROGATIVE_LEAD =
  /^(?:why|how|what|when|where|which|who|does|do|is|are|can|should|will)\s+/i;

/** Returns the cleaned query, or null when nothing searchable remains.
 *  Question-phrased queries are de-interrogated — search backends answer
 *  "why …" with dictionary definitions of "why". */
export function sanitizeQuery(query: string): string | null {
  const cleaned = query
    .replace(DOUBLE_QUOTES, '"')
    .replace(SINGLE_QUOTES, "'")
    .replace(BOX_SCAFFOLD, "")
    .trim();
  if (cleaned.length < 8) return null;
  if (/-\s*$/.test(cleaned)) return null; // trailing dash = empty query slot
  const stripped = cleaned
    .replace(INTERROGATIVE_LEAD, "")
    .replace(INTERROGATIVE_LEAD, "")
    .replace(/\?+\s*$/, "")
    .trim();
  return stripped.length >= 8 ? stripped : cleaned;
}

/** Progressively relax an over-constrained query: strip site:/intitle:/inurl:
 *  operators and -negations, then unquote phrases. Empty retries re-run the
 *  RELAXED form instead of repeating a dead query. */
export function relaxQuery(query: string): string {
  return query
    .replace(/\b(?:site|inurl):\S+/gi, " ")
    .replace(/\bintitle:/gi, "")
    .replace(/(^|\s)-(?:"[^"]*"|\S+)/g, " ")
    .replace(/"([^"]*)"/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx research.checks.ts`
Expected: all `PASS`, final line `research checks: all green`.

- [ ] **Step 5: Verify purity guard still green**

Run: `npx tsx __guard.checks.ts`
Expected: `Scanned N engine core files.` with 0 violations (research.ts is now scanned).

- [ ] **Step 6: Commit**

```bash
git add research.ts research.checks.ts
git commit -m "feat(research): query hygiene — sanitizeQuery/relaxQuery (upstreamed)"
```

---

### Task 2: Source tiering — `hostOf` / `sourceTier` / `isSkipHost`

**Files:**
- Modify: `research.ts` (append)
- Modify: `research.checks.ts` (append)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `hostOf(url: string): string`; `sourceTier(url: string, res?: TierRes): 1 | 2 | 3`; `isSkipHost(host: string, skipHosts: string[]): boolean`; `DEFAULT_TIER1_RE: RegExp`; `DEFAULT_LOWTIER_RE: RegExp`; `DEFAULT_CHASE_SKIP_HOSTS: string[]`; `interface TierRes { tier1?: RegExp; low?: RegExp }`. Task 4 ranks and filters with these.

- [ ] **Step 1: Append failing checks to `research.checks.ts`** (before the exit block)

```ts
import {
  hostOf,
  sourceTier,
  isSkipHost,
  DEFAULT_CHASE_SKIP_HOSTS,
} from "./research";

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
ok("skip-host matches subdomains and .mil",
  isSkipHost("cn.wsj.com", DEFAULT_CHASE_SKIP_HOSTS) &&
    isSkipHost("af.mil", DEFAULT_CHASE_SKIP_HOSTS) &&
    !isSkipHost("theguardian.com", DEFAULT_CHASE_SKIP_HOSTS),
  "wsj-subdomain/.mil/guardian triple");
```

- [ ] **Step 2: Run to verify failure** — `npx tsx research.checks.ts` → FAIL (missing exports).

- [ ] **Step 3: Append implementation to `research.ts`**

```ts
/** Class patterns, not an offender blocklist — ported with provenance from
 *  the production adapter (they classified where a name-list classified 0/20). */
export const DEFAULT_TIER1_RE =
  /(\.gov|\.edu|\.mil)$|(^|\.)(reuters|apnews|bloomberg|wsj|nytimes|washingtonpost|ft|theinformation|axios|cnbc|techcrunch|arstechnica|theverge|wired|ieee|nature|sciencemag|spacenews|aviationweek|defensenews|breakingdefense|globenewswire|businesswire|prnewswire|sec|mckinsey|deloitte|gartner|isg-one|burtchworks)\.(com|org|net)$/i;
export const DEFAULT_LOWTIER_RE =
  /course|staffing|recruit|career|jobdescription|jobright|salesfolk|interviewquery|unteachable|usbusinessnews|automateamerica|bestof|top10|insights?hub|guestpost/i;
/** Antibot/paywalled hosts a scrape can never land — skip before burning attempts. */
export const DEFAULT_CHASE_SKIP_HOSTS: string[] = [
  "wsj.com", "bloomberg.com", "nytimes.com", "reuters.com", "mckinsey.com", "ft.com",
];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export interface TierRes {
  tier1?: RegExp;
  low?: RegExp;
}

export function sourceTier(url: string, res?: TierRes): 1 | 2 | 3 {
  const host = hostOf(url);
  if ((res?.tier1 ?? DEFAULT_TIER1_RE).test(host)) return 1;
  if ((res?.low ?? DEFAULT_LOWTIER_RE).test(host)) return 3;
  return 2;
}

export function isSkipHost(host: string, skipHosts: string[]): boolean {
  return (
    host.endsWith(".mil") ||
    skipHosts.some((h) => host === h || host.endsWith(`.${h}`))
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npx tsx research.checks.ts` → all PASS.
- [ ] **Step 5: Commit**

```bash
git add research.ts research.checks.ts
git commit -m "feat(research): source tiering + skip-host classifier (upstreamed)"
```

---

### Task 3: Throttled search — gap gate, relaxed empty-retry, circuit breaker

**Files:**
- Modify: `research.ts` (append)
- Modify: `research.checks.ts` (append)

**Interfaces:**
- Consumes: `SearchClient` from `./ports`; `sanitizeQuery`/`relaxQuery` (Task 1).
- Produces:

```ts
interface ResearchKnobs {
  researchLimit: number;        // 5
  primaryChaseMax: number;      // 2
  primaryChaseMaxChars: number; // 60000
  chasedMinChars: number;       // 500
  chaseSkipHosts: string[];     // DEFAULT_CHASE_SKIP_HOSTS
  searchMinGapMs: number;       // 3000
  searchEmptyRetries: number;   // 2
  searchEmptyRetryBaseMs: number; // 10000
  searchBreakerAfter: number;   // 8
}
interface ResearchStackOpts {
  search: SearchClient;
  knobs?: Partial<ResearchKnobs>;
  tierRes?: TierRes;
  recordArtifact?: (label: string, input: string, output: string) => void;
  log?: (line: string) => void;
  /** Optional retry wrapper for scrape/search transport attempts — pass the
   *  preset's withRetry so attempts land in run telemetry (zerogtalent
   *  parity). Default: plain 2-attempt inline retry, no recording. */
  withRetry?: <T>(label: string, fn: () => Promise<T>, o?: { maxAttempts?: number }) => Promise<T>;
  sleep?: (ms: number) => Promise<void>; // injectable for checks
  now?: () => number;                    // injectable for checks
}
interface ResearchStack {
  throttledSearch(query: string, label: string): Promise<SearchResult[]>;
  gatherResearch(topic: string): Promise<{ block: string; sources: { title: string; url: string }[] }>; // Task 4
  drainDroppedUrls(count: number): string[];  // Task 4
  resetRunState(): void;
}
export function createResearchStack(opts: ResearchStackOpts): ResearchStack
```

- [ ] **Step 1: Append failing checks** (fake SearchClient with a scripted per-call result queue; `sleep`/`now` injected as instant fakes)

```ts
import { createResearchStack } from "./research";
import type { SearchClient, SearchResult } from "./ports";

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
```

(The checks file is already an async `main()` per Task 1 — append these sections inside it, before the exit logic.)

- [ ] **Step 2: Run to verify failure** — `npx tsx research.checks.ts` → FAIL (`createResearchStack` missing).

- [ ] **Step 3: Implement.** Adapt zerogtalent `generate.ts:1151–1311` onto the port: `p-limit(1)` gate with `searchMinGapMs` spacing (via injected `now`/`sleep`), sanitize → skip null (record artifact "skipped: scaffold/empty query"), attempt loop `searchEmptyRetries + 1` long where attempts > 0 use `relaxQuery` when it differs — **and re-run the SAME query when it doesn't** (suspected-block semantics; do not skip retries on identical relaxed form), exponential `searchEmptyRetryBaseMs * 2**attempt` waits, `consecutiveEmptySearches` instance counter with `searchBreakerAfter` short-circuit, `recordArtifact` on hit/skip/exhaustion, all `log` lines optional. State lives on the factory instance; `resetRunState()` zeroes ALL of it — gate timestamp, breaker counter, and (once Task 4 adds them) the chase-dedupe set and dropped-URL pool (zerog parity: its reset clears the pool too, `generate.ts:913–918`). No retry wrapper here beyond the empty-retry loop — transport retries belong to the caller's SearchClient.

- [ ] **Step 4: Run to verify pass** — `npx tsx research.checks.ts` → all PASS.
- [ ] **Step 5: Commit**

```bash
git add research.ts research.checks.ts
git commit -m "feat(research): throttled search — gap gate, relaxed empty-retry, breaker (upstreamed)"
```

---

### Task 4: `gatherResearch` — tier-ranked block, primary chase, dropped-URL pool

**Files:**
- Modify: `research.ts` (append into the factory)
- Modify: `research.checks.ts` (append)

**Interfaces:**
- Consumes: Task 3's factory internals; `SearchClient.scrape?`.
- Produces: `stack.gatherResearch(topic)` → `{ block, sources }` (satisfies the preset seam `(topic: string) => Promise<{ block: string }>` structurally); `stack.drainDroppedUrls(count)`.

- [ ] **Step 1: Append failing checks.** Fake search returns 3 hits: one tier-1 (apnews, content present), one tier-2 whose content hyperlinks `https://apnews.com/orig/story` (chase candidate), one tier-3 content-farm. Fake `scrape` returns a 600-char body for the chased URL. Assert:

```ts
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
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Adapt `generate.ts:1313–1524`. **Port-field mapping — two distinct sites (do not blanket-replace):** chase-link extraction reads `content ?? ""` (matches source line 1373); the RANKED BODY read is `content ?? snippet` (source: `r.markdown ?? r.description ?? ""` — a blanket `content ?? ""` would silently kill the snippet fallback for unscraped hits, and no fixture would catch it). Flow: search via `throttledSearch` → filter `isSkipHost` hits into the pool → tier-rank (`sort by tier asc`) → chase loop (regex URLs out of each non-tier-1 content, tier-1 only, per-instance `chasedUrls` dedupe, root-path guard `pathname.length <= 1`, skip-host pooling, `scrape` via port when defined through the `withRetry` hook with `maxAttempts: 2`, `chasedMinChars` floor, `primaryChaseMaxChars` cap with truncation marker) → **cap every RANKED body at `primaryChaseMaxChars` too, with the `[... truncated: document continues]` marker** (source lines 1467–1478 — "direct results were the one uncapped door into the block"; a 1.03M-char SEC filing once ballooned every downstream prompt) → assemble `### Source P{n}` chased blocks first, then ranked blocks with tier labels (tier-1 `" (tier 1 — primary/wire/major outlet)"`, tier-3 the full LOW-AUTHORITY warning string from the source, verbatim) → record ONE composition artifact per topic via `recordArtifact` (tier counts, chased URLs, block char size — source lines 1502–1524) → return `{ block, sources }`. `search.scrape === undefined` → skip chase entirely, `log` once. Zero results after retries → throw `Error("No search results for \"<topic>\" after N spaced attempts — cannot ground the article")`.

Additional check to append alongside Step 1's (cap + fallback + artifact):

```ts
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
```
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Full gate** — `npm run build && npm run test:checks` → green.
- [ ] **Step 6: Commit**

```bash
git add research.ts research.checks.ts
git commit -m "feat(research): gatherResearch — tier-ranked corpus, primary chase, dropped pool (upstreamed)"
```

---

### Task 5: Chunked extractive research — generalize `examples/run-politics.ts` into the engine

**Files:**
- Modify: `research.ts` (append `createExtractiveResearch`)
- Modify: `research.checks.ts` (append)
- Modify: `examples/run-politics.ts` (delete its local `createScrapeResearch`/`chunkText`, import from `../research`)

**Interfaces:**
- Consumes: `LlmClient`, `SearchClient` ports.
- Produces:

```ts
export function createExtractiveResearch(opts: {
  llm: LlmClient;
  search: SearchClient;
  pagesPerTopic: number;    // politics runner used 3
  chunkChars: number;       // 24000
  maxChunksPerPage: number; // 4
  minContentChars: number;  // 400 — content-quality floor: shorter scrapes fall back to snippet
  log?: (line: string) => void;
}): (topic: string) => Promise<{ block: string }>
```

- [ ] **Step 1: Append failing checks.** Fake `search` (2 hits) + fake `scrape` (one 30k-char body → expect 2 extraction calls; one throwing → expect snippet fallback) + fake `llm.complete` capturing prompts and returning `"- fact"` for part 1 and `"NONE"` for part 2. Assert: chunk math (`PAGE … (part 1/2)` and `part 2/2` prompts seen), `NONE` parts filtered, failed scrape degrades to `- <title>: <snippet>` line, sub-`minContentChars` scrape also degrades, block concatenates `SOURCE <title> (<url>):` sections.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — move the proven logic from `examples/run-politics.ts` (already written and live-tested 2026-07-20) into the factory verbatim **plus one addition that does NOT exist in the runner today: the `minContentChars` gate** (a successful scrape below the floor degrades to the snippet line, same as a failed scrape — this is the Phase-1 half of the spec's content-quality floor). Extraction system prompt text moves unchanged:

```
You extract evidence for a news article. From the page text, list every concrete fact, statistic, date, named person or institution, and direct quote (verbatim, in quotation marks, with who said it) relevant to the topic. Dense bullet points only, no commentary. If nothing is relevant, reply exactly: NONE
```

- [ ] **Step 4: Rewire `examples/run-politics.ts`** to `import { createExtractiveResearch } from "../research"` and pass `{ llm, search, pagesPerTopic: 3, chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400, log: (l) => process.stdout.write(l + "\n") }`; delete the local copies.
- [ ] **Step 5: Run to verify pass** — `npx tsx research.checks.ts` AND `npm run build` (catches the example rewiring).
- [ ] **Step 6: Commit**

```bash
git add research.ts research.checks.ts examples/run-politics.ts
git commit -m "feat(research): chunked extractive research factory; politics example now imports it"
```

---

### Task 6: Firecrawl client — construction-time search defaults

**Files:**
- Modify: `clients/firecrawl-search.ts`
- Modify: `clients/firecrawl-search.checks.ts` (create if absent — live-skip style like `clients/searxng-search.checks.ts`)

**Interfaces:**
- Consumes: `firecrawl` SDK (already a dep).
- Produces: `createFirecrawlSearch(opts: { apiKey?: string; apiUrl?: string; searchDefaults?: { sources?: NonNullable<Parameters<Firecrawl["search"]>[1]>["sources"]; tbs?: string; scrape?: boolean } })` — `sources` is typed OFF THE SDK (a plain `string[]` fails strict tsc against firecrawl 4.28.1's literal-union `Array<"web"|"news"|"images"|…>`). Every `search()` call merges `searchDefaults` under its per-call opts. **Never add `excludeDomains`** — documented regression: SearXNG-backed `/v2/search` returns ZERO results for any query carrying it (verified in production 2026-07-08); host filtering is app-side (`isSkipHost`).

- [ ] **Step 1: Write the failing check** — live-skip pattern: without `FIRECRAWL_API_URL` print `SKIP firecrawl parity — FIRECRAWL_API_URL not set` and exit 0; with it, construct with `searchDefaults: { scrape: true }`, search a fixed query with `limit: 2`, assert **at least one** result has non-empty `content` (proof the default reached the wire — "every result" would flake on real antibot scrape failures).
- [ ] **Step 2: Run offline** — `npx tsx clients/firecrawl-search.checks.ts` → `SKIP …` exit 0.
- [ ] **Step 3: Implement** the `searchDefaults` merge in the client (spread defaults first, per-call opts win). Add the `excludeDomains` warning comment verbatim at the merge site.
- [ ] **Step 4: Live verification (operator env):**

```bash
FIRECRAWL_API_URL=$(grep '^FIRECRAWL_API_URL=' /Users/misha/claude_projects/fedwork/workers/journalist/.env | cut -d= -f2) \
FIRECRAWL_API_KEY=$(grep '^FIRECRAWL_API_KEY=' /Users/misha/claude_projects/fedwork/workers/journalist/.env | cut -d= -f2) \
npx tsx clients/firecrawl-search.checks.ts
```

Expected: PASS lines (content present on scraped results).

- [ ] **Step 5: Commit**

```bash
git add clients/firecrawl-search.ts clients/firecrawl-search.checks.ts
git commit -m "feat(clients): firecrawl searchDefaults (sources/tbs/scrape) — excludeDomains stays banned"
```

---

### Task 7: Integration gate, docs, changelog

**Files:**
- Modify: `CUSTOMIZING.md` (new "Deep research" section)
- Modify: `CHANGELOG.md` (Unreleased entry)

**Interfaces:** none new — this task proves the whole phase.

- [ ] **Step 1: Docs.** Append to `CUSTOMIZING.md` a section showing both opt-ins through the existing seam:

```ts
import { createResearchStack, createExtractiveResearch } from "ai-journalist/research";

// Tiered corpus + primary chase (production-grade grounding).
// IMPORTANT: construct the client with searchDefaults — the port's
// search(query, {limit}) cannot pass scrape/sources per call, so without
// these defaults results carry no content: the chase finds no links and
// every body silently degrades to its snippet.
const search = createFirecrawlSearch({
  searchDefaults: { scrape: true, sources: ["news"] },
});
const stack = createResearchStack({
  search,
  // Optional provenance: without this, artifacts go nowhere — the preset's
  // internal RunContext is NOT exposed, so pass your own sink (e.g. append
  // to out/runs/<runId>/research.log).
  recordArtifact: (label, input, output) => myRunLog.append({ label, input, output }),
});
const internals = createDefaultInternals({ llm, search, brand, source,
  gatherResearch: (t) => stack.gatherResearch(t) });

// Or: full-page scrape + chunked LLM extraction (small-model friendly):
const internals2 = createDefaultInternals({ llm, search, brand, source,
  gatherResearch: createExtractiveResearch({ llm, search, pagesPerTopic: 3,
    chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400 }) });
```

Also add `"./research": "./research.ts"` to `package.json` `exports`.

- [ ] **Step 2: CHANGELOG** — add a `## Unreleased` heading above the latest version, with FLAT bullets matching the file's existing idiom (the file uses flat bullets under version headings, no `### Added` subheads — follow it): one bullet per module (query hygiene, tiering, throttled search + breaker, gatherResearch + chase, extractive research, firecrawl searchDefaults), each "opt-in; defaults unchanged".
- [ ] **Step 3: Full gate.**

Run: `npm run build && npm run test:checks && npm run test:example`
Expected: tsc clean; every checks file green (including untouched byte-locks); offline example passes.

- [ ] **Step 4: Commit**

```bash
git add CUSTOMIZING.md CHANGELOG.md package.json
git commit -m "docs: research stack opt-in guide + changelog (Phase 1 complete)"
```

- [ ] **Step 5: STOP — do not publish.** Version bump + npm publish ride the repo's tag-publish CI and are the operator's call. Phase 2 (news desk) gets its own plan on top of these APIs.

---

## Dependencies considered and rejected (do not re-litigate without new evidence)

- **`p-throttle`** (would replace the gap gate): no injectable clock — our
  deterministic checks would need real 3s sleeps or global timer mocks under
  raw tsx. The hand-rolled gate exists for testability.
- **`p-retry`** (would replace the empty-retry loop): retries the SAME
  thunk on throw; our retry substitutes the RELAXED query form on an empty
  (non-throwing) result — wrong shape.
- **`opossum`** (circuit breaker): hystrix-class machinery for a 5-line
  consecutive-empty counter.
- **`linkify-it`** (chase URL extraction): proper extractor, but the ported
  regex + punctuation trim carries production fixes documented in the source
  comments; swap only if edge cases surface in practice.

**Deferred to the Phase 2 plan:** teaser/paywall-marker half of the
content-quality floor (Phase 1 ships `minContentChars` only); `tldts` for
outlet-host parsing if URL edge cases appear in the newswire source.

## Self-review (done at write time)

- **Spec coverage:** Phase 1 scope of the spec = sanitizer ✓ (T1), relax ✓ (T1), tiering ✓ (T2), breaker + throttle ✓ (T3), chase + provenance hooks ✓ (T4, `recordArtifact`), chunked extractor ✓ (T5), firecrawl news-bias/tbs/scrape-at-search ✓ (T6), seams + docs + defaults-unchanged ✓ (T7). News-desk modules, Wikipedia parallels, personas, GN source = Phase 2 plan (deliberately absent here).
- **Placeholders:** none — every step carries code, a command, or an exact source-line range to port.
- **Type consistency:** `ResearchStack`/`ResearchKnobs`/`TierRes` defined once (T3/T2) and consumed by name in T4/T5/T7; `createExtractiveResearch` signature identical in T5 and T7 docs.
