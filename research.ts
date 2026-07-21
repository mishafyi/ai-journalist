/**
 * research.ts — the engine's hardened research stack, upstreamed from a
 * production adapter (query hygiene, source tiering, throttled search with
 * a dead-upstream breaker, primary-source chase, chunked extraction).
 * Port-pure: speaks only SearchClient/LlmClient; all knobs are arguments.
 * Everything here is OPT-IN — presets keep their cheap snippet default.
 */
import pLimit from "p-limit";
import type { SearchClient, SearchResult } from "./ports";
import { DEFAULT_BLOCKED_HOSTS, isBlockedHost } from "./news";

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

/** Skip-host classification is REUSED from ./news (identical list + matcher
 *  already shipped there) and re-exported for one-import consumption. */
export { isBlockedHost, DEFAULT_BLOCKED_HOSTS } from "./news";

/** Class patterns, not an offender blocklist — ported with provenance from
 *  the production adapter (they classified where a name-list classified 0/20). */
export const DEFAULT_TIER1_RE =
  /(\.gov|\.edu|\.mil)$|(^|\.)(reuters|apnews|bloomberg|wsj|nytimes|washingtonpost|ft|theinformation|axios|cnbc|techcrunch|arstechnica|theverge|wired|ieee|nature|sciencemag|spacenews|aviationweek|defensenews|breakingdefense|globenewswire|businesswire|prnewswire|sec|mckinsey|deloitte|gartner|isg-one|burtchworks)\.(com|org|net)$/i;
export const DEFAULT_LOWTIER_RE =
  /course|staffing|recruit|career|jobdescription|jobright|salesfolk|interviewquery|unteachable|usbusinessnews|automateamerica|bestof|top10|insights?hub|guestpost/i;

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

// ───────────────────────────────────────────────────────────────────────────
// Research stack factory — throttled search (gap gate + relaxed empty-retry +
// dead-upstream breaker), tier-ranked gatherResearch with primary-source
// chase, dropped-URL pool + retryThin backfill, hardened SearchClient facade;
// chunked extraction lands in a later task. All run state (gate timestamp,
// breaker counter, pool, dedupe, scrape memo, …) is INSTANCE state, so hosts
// running several stacks — or several runs in one process — never share it.
// ───────────────────────────────────────────────────────────────────────────

export interface ResearchKnobs {
  researchLimit: number; // 5
  primaryChaseMax: number; // 2
  primaryChaseMaxChars: number; // 60000
  chasedMinChars: number; // 500
  chaseSkipHosts: string[]; // DEFAULT_BLOCKED_HOSTS (reused from ./news)
  searchMinGapMs: number; // 3000
  searchEmptyRetries: number; // 2
  searchEmptyRetryBaseMs: number; // 10000
  searchBreakerAfter: number; // 8
  thinRetryUrls: number; // 3 — retryThin scrape budget per call
}

export interface ResearchStackOpts {
  search: SearchClient;
  knobs?: Partial<ResearchKnobs>;
  tierRes?: TierRes;
  recordArtifact?: (label: string, input: string, output: string) => void;
  log?: (line: string) => void;
  /** Optional retry wrapper for scrape/search transport attempts — pass the
   *  preset's withRetry so attempts land in run telemetry (zerogtalent
   *  parity). Default: plain 2-attempt inline retry, no recording. */
  withRetry?: <T>(
    label: string,
    fn: () => Promise<T>,
    o?: { maxAttempts?: number },
  ) => Promise<T>;
  sleep?: (ms: number) => Promise<void>; // injectable for checks
  now?: () => number; // injectable for checks
}

export interface ResearchStack {
  throttledSearch(query: string, label: string): Promise<SearchResult[]>;
  gatherResearch(
    topic: string,
  ): Promise<{ block: string; sources: { title: string; url: string }[] }>;
  /** Last-resort thin-section backfill: drain up to knobs.thinRetryUrls
   *  pooled URLs, scrape (memoized, gated), 500-char floor, 60K cap,
   *  "### Source" blocks — "" when the pool is dry. Preset adapts it
   *  to the engine seam: retryThin: (s) => stack.retryThin(s.heading). */
  retryThin(label: string): Promise<string>;
  /** Hardened SearchClient facade: search = sanitize+throttle+breaker,
   *  scrape = memoized passthrough. Pass THIS as the preset's `search` port
   *  so discovery/snippet paths — where the junk queries actually happened —
   *  inherit the hardening and share the process-wide gap gate. */
  asSearchClient(): SearchClient;
  /** Late-bind hooks the preset can only supply AFTER its factory ran
   *  (withRetry / recordArtifact chicken-and-egg — see Task 6.5). */
  bind(hooks: {
    withRetry?: ResearchStackOpts["withRetry"];
    recordArtifact?: ResearchStackOpts["recordArtifact"];
  }): void;
  drainDroppedUrls(count: number): string[];
  resetRunState(): void; // clears gate/breaker/pool/chase-dedupe AND the scrape memo
}

const DEFAULT_KNOBS: ResearchKnobs = {
  researchLimit: 5,
  primaryChaseMax: 2,
  primaryChaseMaxChars: 60_000,
  chasedMinChars: 500,
  chaseSkipHosts: [...DEFAULT_BLOCKED_HOSTS],
  searchMinGapMs: 3_000,
  searchEmptyRetries: 2,
  searchEmptyRetryBaseMs: 10_000,
  searchBreakerAfter: 8,
  thinRetryUrls: 3,
};

/** Default transport wrapper when no preset withRetry is bound: plain
 *  2-attempt inline retry, no telemetry recording, rethrows the last error. */
async function inlineRetry<T>(
  _label: string,
  fn: () => Promise<T>,
  o?: { maxAttempts?: number },
): Promise<T> {
  const attempts = o?.maxAttempts ?? 2;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function createResearchStack(opts: ResearchStackOpts): ResearchStack {
  const knobs: ResearchKnobs = { ...DEFAULT_KNOBS, ...opts.knobs };
  const search = opts.search;
  const log = opts.log;
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  // Late-bound hooks (see bind()) — the preset can only construct its
  // withRetry/recordArtifact AFTER this factory ran, so they live in mutable
  // instance slots read at call time, never captured.
  let recordArtifact = opts.recordArtifact;
  let withRetry: NonNullable<ResearchStackOpts["withRetry"]> =
    opts.withRetry ?? inlineRetry;

  // ── per-run instance state — resetRunState() zeroes ALL of it ──
  const gate = pLimit(1); // serialize every search AND scrape through this instance
  let lastSearchAt = 0; // gap-gate timestamp
  let consecutiveEmptySearches = 0; // breaker counter
  // Run-wide chase dedupe (zerog R7: the same URL was primary-chased 3× in one
  // run because the set was call-local) + one skip-log line per host.
  const chasedUrls = new Set<string>();
  const chaseSkipLogged = new Set<string>();
  // Pool of research URLs seen but never scraped (overflow + antibot-skipped
  // chase links). gatherResearch feeds it; retryThin drains it as last-resort
  // grounding for a section whose own research came back empty.
  const droppedUrls: string[] = [];
  // ONE scrape memo shared by chase + retryThin + facade — sections researching
  // in parallel share top hits; on a memory-bound scrape backend every avoided
  // re-scrape is real latency back.
  const scrapeMemo = new Map<string, string>();

  const isSkipHost = (host: string): boolean =>
    isBlockedHost(host, knobs.chaseSkipHosts);
  const poolUrl = (url: string): void => {
    if (!droppedUrls.includes(url)) droppedUrls.push(url);
  };
  /** Per-document ceiling — chased, ranked, and thin-retry bodies all get the
   *  same cap (zerog R7C3: an 878k-char PDF ballooned every downstream prompt). */
  const capBody = (text: string, kind: "document" | "chased document"): string =>
    text.length > knobs.primaryChaseMaxChars
      ? `${text.slice(0, knobs.primaryChaseMaxChars)}\n\n[... truncated: ${kind} continues]`
      : text;

  /** Memoized, gated, 2-attempt scrape — the ONE path every scrape (primary
   *  chase, thin retry, facade) routes through. Serialized through the same
   *  instance gate as searches (memory-bound backend). Throws when the
   *  underlying client has no scrape port — callers guard. */
  const memoScrape = async (url: string, label: string): Promise<string> => {
    const hit = scrapeMemo.get(url);
    if (hit !== undefined) return hit;
    const scrape = search.scrape;
    if (!scrape) {
      throw new Error(
        `memoScrape(${url}): search client has no scrape() port`,
      );
    }
    const body = (
      await gate(() => withRetry(label, () => scrape(url), { maxAttempts: 2 }))
    ).trim();
    scrapeMemo.set(url, body);
    return body;
  };

  /** One gap-spaced search through the instance-wide gate (no empty-retry
   *  here). A burst of searches from a datacenter IP gets BLANKED by the
   *  upstream after the first few — so serialize with a minimum gap, waiting
   *  INSIDE the gate; empty-retry waits happen outside it, so other spaced
   *  searches keep flowing. */
  const gatedSearchOnce = (
    query: string,
    label: string,
    limit?: number, // per-call override (facade) — knobs.researchLimit otherwise
  ): Promise<SearchResult[]> =>
    gate(async () => {
      const wait = lastSearchAt + knobs.searchMinGapMs - now();
      if (wait > 0) await sleep(wait);
      try {
        return await withRetry(
          label,
          () => search.search(query, { limit: limit ?? knobs.researchLimit }),
          { maxAttempts: 2 },
        );
      } finally {
        lastSearchAt = now();
      }
    });

  /** Spaced + retried search. An empty result set is retried with growing
   *  delays (suspected block) — the retry re-runs the RELAXED form when it
   *  differs, and the SAME query when it doesn't (a dead upstream blanks good
   *  queries too). Returns [] only after all attempts came back empty; callers
   *  decide whether empty is fatal. */
  const throttledSearch = async (
    rawQuery: string,
    label: string,
    limit?: number, // per-call override (facade only); public 2-arg shape unchanged
  ): Promise<SearchResult[]> => {
    const query = sanitizeQuery(rawQuery);
    if (query === null) {
      recordArtifact?.(
        `search: ${rawQuery.slice(0, 80)}`,
        rawQuery,
        "skipped: scaffold/empty query (sanitizer)",
      );
      return [];
    }
    if (consecutiveEmptySearches >= knobs.searchBreakerAfter) {
      recordArtifact?.(
        `search: ${query.slice(0, 80)}`,
        query,
        `skipped: search breaker open (${consecutiveEmptySearches} consecutive empty — backend down)`,
      );
      return [];
    }
    const relaxed = relaxQuery(query);
    for (let attempt = 0; attempt <= knobs.searchEmptyRetries; attempt += 1) {
      // First attempt: the query as given. Empty retries: the relaxed form
      // when it differs — converts wasted repeat-attempts into recovery ones.
      const attemptQuery = attempt > 0 && relaxed !== query ? relaxed : query;
      const web = await gatedSearchOnce(attemptQuery, label, limit);
      if (web.length > 0) {
        consecutiveEmptySearches = 0;
        // Step provenance: every search persists query → result list (title +
        // url only). When the RELAXED retry form is what hit, the artifact
        // says so.
        recordArtifact?.(
          `search: ${query.slice(0, 80)}`,
          attemptQuery === query
            ? query
            : `${query}\n[relaxed on retry to] ${attemptQuery}`,
          web.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join("\n"),
        );
        return web;
      }
      if (attempt < knobs.searchEmptyRetries) {
        const delayMs = knobs.searchEmptyRetryBaseMs * 2 ** attempt;
        log?.(
          `search returned 0 results (suspected block) for "${query.slice(0, 80)}" — retrying in ${Math.round(delayMs / 1000)}s (${attempt + 1}/${knobs.searchEmptyRetries})`,
        );
        await sleep(delayMs);
      }
    }
    consecutiveEmptySearches += 1;
    recordArtifact?.(
      `search: ${query.slice(0, 80)}`,
      query,
      `0 results after ${knobs.searchEmptyRetries + 1} spaced attempts (suspected block)`,
    );
    return [];
  };

  /** Deep research for one topic: tier-ranked scraped corpus + primary-source
   *  chase + skip-host pooling. Ported from the production adapter
   *  (generate.ts:1313–1524) minus its YouTube enrichment. */
  const gatherResearch = async (
    topic: string,
  ): Promise<{ block: string; sources: { title: string; url: string }[] }> => {
    const webAll = await throttledSearch(topic, `research search (${topic.slice(0, 60)})`);
    // Paywalled/antibot hosts are filtered app-side (never via search-backend
    // excludeDomains — that silently zeroed EVERY query on the SearXNG-backed
    // upstream); skipped hosts still pool for retryThin.
    const web = webAll.filter((r) => !isSkipHost(hostOf(r.url)));
    for (const r of webAll) {
      if (isSkipHost(hostOf(r.url))) poolUrl(r.url);
    }
    if (web.length === 0) {
      throw new Error(
        `No search results for "${topic}" after ${knobs.searchEmptyRetries + 1} spaced attempts — cannot ground the article`,
      );
    }
    // Feed the thin-section backfill pool with results beyond the scrape keep.
    // The search limit == researchLimit, so overflow is rare — the antibot-
    // skipped chase links below are the pool's main feeder.
    for (const r of web.slice(knobs.researchLimit)) poolUrl(r.url);

    // Source-quality ordering + in-corpus labeling: tier-1 first (model
    // attention + fact-guard primary-source rules both read top-down), and
    // low-authority blocks carry an explicit warning so no pass cites them as
    // an authority by name.
    const ranked = web
      .map((r) => ({ r, tier: sourceTier(r.url, opts.tierRes) }))
      .sort((a, b) => a.tier - b.tier);

    // Primary-source chase: any NON-tier-1 block that hyperlinks a tier-1 host
    // is re-citing someone else's reporting — fetch the original (one hop,
    // capped) and let the corpus carry the primary instead of the re-tell.
    const chased: { title: string; url: string; body: string }[] = [];
    if (search.scrape === undefined) {
      log?.("primary chase skipped: search client has no scrape()");
    } else {
      for (const { r, tier } of ranked) {
        if (tier === 1 || chased.length >= knobs.primaryChaseMax) continue;
        const links = (r.content ?? "").match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [];
        for (const link of links) {
          if (chased.length >= knobs.primaryChaseMax) break;
          const clean = link.replace(/[.,;:!?]+$/, "");
          if (sourceTier(clean, opts.tierRes) !== 1 || chasedUrls.has(clean)) {
            continue;
          }
          // Antibot skip-list: a tier-1 host that always rejects the scraper
          // is a guaranteed 2-attempt burn — pool it for retryThin instead
          // (as last-resort backfill for an EMPTY section, even a probably-
          // antibot host is worth one capped attempt) and log once per host.
          const chaseHost = hostOf(clean);
          if (isSkipHost(chaseHost)) {
            poolUrl(clean);
            if (!chaseSkipLogged.has(chaseHost)) {
              chaseSkipLogged.add(chaseHost);
              log?.(`primary chase skipped (antibot host): ${chaseHost}`);
            }
            continue;
          }
          // Domain roots are citation noise, not citations (zerog R7C2:
          // generic .gov root links chased 35k chars of homepage nav).
          try {
            if (new URL(clean).pathname.length <= 1) continue;
          } catch {
            continue;
          }
          chasedUrls.add(clean);
          try {
            const md = await memoScrape(clean, `primary chase (${chaseHost})`);
            if (md.length >= knobs.chasedMinChars) {
              chased.push({
                title: `PRIMARY SOURCE (chased from ${hostOf(r.url)})`,
                url: clean,
                body: capBody(md, "chased document"),
              });
              log?.(
                `primary chased: ${clean} (${md.length} chars${md.length > knobs.primaryChaseMaxChars ? ` → capped ${knobs.primaryChaseMaxChars}` : ""}, via ${hostOf(r.url)})`,
              );
            }
          } catch (err) {
            // Best-effort: a failed chase costs only the attempt — the
            // re-telling block stays in the corpus. Logged, never silent.
            log?.(
              `primary chase failed for ${clean}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
    const tierCounts = ranked.reduce<Record<1 | 2 | 3, number>>(
      (acc, { tier }) => ((acc[tier] += 1), acc),
      { 1: 0, 2: 0, 3: 0 },
    );
    if (tierCounts[3] > 0 || chased.length > 0) {
      log?.(
        `source quality: ${tierCounts[1]} tier-1, ${tierCounts[2]} tier-2, ${tierCounts[3]} low-authority (down-ranked); ${chased.length} primary chased`,
      );
    }

    const sources = [
      ...chased.map((c) => ({ title: c.title, url: c.url })),
      ...ranked.map(({ r }) => ({ title: r.title, url: r.url })),
    ];
    const tierLabel = (tier: 1 | 2 | 3): string =>
      tier === 1
        ? " (tier 1 — primary/wire/major outlet)"
        : tier === 3
          ? " (tier 3 — LOW-AUTHORITY content site: treat its claims with suspicion, prefer any other source for the same fact, and NEVER cite this host by name as an authority)"
          : "";
    const block = [
      ...chased.map(
        (c, i) => `### Source P${i + 1}: ${c.title}\nURL: ${c.url}\n\n${c.body}`,
      ),
      ...ranked.map(({ r, tier }, i) => {
        // content ?? snippet — NOT content ?? "": an unscraped hit still
        // grounds with its snippet. Capped like chased docs (a 1.03M-char SEC
        // filing served DIRECT once blew every downstream prompt — direct
        // results were the one uncapped door into the block).
        const raw = (r.content ?? r.snippet).trim();
        return `### Source ${i + 1}${tierLabel(tier)}: ${r.title}\nURL: ${r.url}\n\n${capBody(raw, "document")}`;
      }),
    ].join("\n\n---\n\n");

    // Step provenance: the deep-research composition — which sources ranked at
    // which tier and which primaries were chased — as one compact artifact row.
    // The scraped block itself is NOT duplicated here: it lands verbatim inside
    // the consuming stage's own prompt artifact.
    recordArtifact?.(
      `research: ${topic.slice(0, 80)}`,
      topic,
      [
        ...chased.map(
          (c, i) =>
            `P${i + 1} (chased primary): ${c.title} — ${c.url} (${c.body.length} chars)`,
        ),
        ...ranked.map(({ r, tier }, i) => {
          const n = (r.content ?? r.snippet).length;
          return `${i + 1} [tier ${tier}]: ${r.title} — ${r.url} (${n} chars${n > knobs.primaryChaseMaxChars ? ` → capped ${knobs.primaryChaseMaxChars}` : ""})`;
        }),
        `block: ${block.length} chars`,
      ].join("\n"),
    );

    return { block, sources };
  };

  /** Thin-section backfill: drain up to knobs.thinRetryUrls pooled URLs (each
   *  leaves the pool — tried at most once per run), scrape them with the
   *  primary-chase pattern (same 2-attempt cap + char floor/cap), and return a
   *  mini research block. "" when the pool is dry or nothing scraped — the
   *  caller then falls to its qualitative fallback. */
  const retryThin = async (label: string): Promise<string> => {
    if (search.scrape === undefined) {
      log?.(`thin-section backfill (${label}) skipped: no scrape() port`);
      return "";
    }
    const batch = droppedUrls.splice(0, knobs.thinRetryUrls);
    if (batch.length === 0) return "";
    const blocks: string[] = [];
    for (const url of batch) {
      try {
        const md = await memoScrape(url, `thin retry (${hostOf(url)})`);
        if (md.length < knobs.chasedMinChars) continue; // same "real document" floor as the chase
        blocks.push(
          `### Source (thin-retry): ${url}\nURL: ${url}\n\n${capBody(md, "document")}`,
        );
      } catch (err) {
        // Best-effort backfill: a failed scrape costs only the attempt — the
        // section falls through to the caller's qualitative fallback.
        log?.(
          `thin retry failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    log?.(
      `thin-section backfill (${label}): scraped ${blocks.length}/${batch.length} pool URLs`,
    );
    recordArtifact?.(
      `thin-retry: ${label.slice(0, 80)}`,
      batch.join("\n"),
      `kept ${blocks.length}/${batch.length} pool URLs`,
    );
    return blocks.join("\n\n---\n\n");
  };

  return {
    throttledSearch,
    gatherResearch,
    retryThin,
    asSearchClient(): SearchClient {
      // Hardened facade: hand THIS to a preset as its `search` port so the
      // discovery/snippet paths — where junk queries actually happened —
      // inherit sanitize+throttle+breaker and share the instance gap gate.
      return {
        search: (query, o) =>
          throttledSearch(query, `facade search (${query.slice(0, 60)})`, o?.limit),
        ...(search.scrape === undefined
          ? {}
          : {
              scrape: (url: string) => memoScrape(url, `scrape (${hostOf(url)})`),
            }),
      };
    },
    bind(hooks): void {
      if (hooks.withRetry) withRetry = hooks.withRetry;
      if (hooks.recordArtifact) recordArtifact = hooks.recordArtifact;
    },
    drainDroppedUrls(count: number): string[] {
      return droppedUrls.splice(0, count);
    },
    resetRunState(): void {
      lastSearchAt = 0;
      consecutiveEmptySearches = 0;
      chasedUrls.clear();
      chaseSkipLogged.clear();
      droppedUrls.length = 0;
      scrapeMemo.clear();
    },
  };
}
