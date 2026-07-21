/**
 * research.ts — the engine's hardened research stack, upstreamed from a
 * production adapter (query hygiene, source tiering, throttled search with
 * a dead-upstream breaker, primary-source chase, chunked extraction).
 * Port-pure: speaks only SearchClient/LlmClient; all knobs are arguments.
 * Everything here is OPT-IN — presets keep their cheap snippet default.
 */
import pLimit from "p-limit";
import type { SearchClient, SearchResult } from "./ports";
import { DEFAULT_BLOCKED_HOSTS } from "./news";

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
// dead-upstream breaker) now; gather/chase/extract land in a later task. All
// run state (gate timestamp, breaker counter, …) is INSTANCE state, so hosts
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
  ): Promise<{ block: string; sources: { title: string; url: string }[] }>; // Task 4
  /** Last-resort thin-section backfill: drain up to knobs.thinRetryUrls
   *  pooled URLs, scrape (memoized, gated), 500-char floor, 60K cap,
   *  "### Source" blocks — "" when the pool is dry. Task 4. Preset adapts it
   *  to the engine seam: retryThin: (s) => stack.retryThin(s.heading). */
  retryThin(label: string): Promise<string>;
  /** Hardened SearchClient facade: search = sanitize+throttle+breaker,
   *  scrape = memoized passthrough. Pass THIS as the preset's `search` port
   *  so discovery/snippet paths — where the junk queries actually happened —
   *  inherit the hardening and share the process-wide gap gate. Task 4. */
  asSearchClient(): SearchClient;
  /** Late-bind hooks the preset can only supply AFTER its factory ran
   *  (withRetry / recordArtifact chicken-and-egg — see Task 6.5). */
  bind(hooks: {
    withRetry?: ResearchStackOpts["withRetry"];
    recordArtifact?: ResearchStackOpts["recordArtifact"];
  }): void;
  drainDroppedUrls(count: number): string[]; // Task 4
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
  const gate = pLimit(1); // serialize every search through this instance
  let lastSearchAt = 0; // gap-gate timestamp
  let consecutiveEmptySearches = 0; // breaker counter

  /** One gap-spaced search through the instance-wide gate (no empty-retry
   *  here). A burst of searches from a datacenter IP gets BLANKED by the
   *  upstream after the first few — so serialize with a minimum gap, waiting
   *  INSIDE the gate; empty-retry waits happen outside it, so other spaced
   *  searches keep flowing. */
  const gatedSearchOnce = (
    query: string,
    label: string,
  ): Promise<SearchResult[]> =>
    gate(async () => {
      const wait = lastSearchAt + knobs.searchMinGapMs - now();
      if (wait > 0) await sleep(wait);
      try {
        return await withRetry(
          label,
          () => search.search(query, { limit: knobs.researchLimit }),
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
      const web = await gatedSearchOnce(attemptQuery, label);
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

  return {
    throttledSearch,
    gatherResearch(
      topic: string,
    ): Promise<{ block: string; sources: { title: string; url: string }[] }> {
      throw new Error("implemented in a later task");
    },
    retryThin(label: string): Promise<string> {
      throw new Error("implemented in a later task");
    },
    asSearchClient(): SearchClient {
      throw new Error("implemented in a later task");
    },
    bind(hooks): void {
      if (hooks.withRetry) withRetry = hooks.withRetry;
      if (hooks.recordArtifact) recordArtifact = hooks.recordArtifact;
    },
    drainDroppedUrls(count: number): string[] {
      throw new Error("implemented in a later task");
    },
    resetRunState(): void {
      lastSearchAt = 0;
      consecutiveEmptySearches = 0;
      // Task 4 run-state clears land HERE: chase-dedupe set, dropped-URL
      // pool, and the scrape memo (zerog parity — its reset clears the pool
      // too, generate.ts:913–918).
    },
  };
}
