/**
 * Google News Top-Stories RSS → ranked, PRE-CLUSTERED trending stories.
 * Extends news.ts's validated fetch pattern (15s timeout). GN item links are
 * JS-redirect stubs — NEVER decoded, NEVER scraped (per spec); resolution
 * happens by headline-matching against our own outlet feeds (matching.ts).
 * The <description> carries the coverage list: <ol><li><a>headline</a>
 * <font>Outlet</font></li>… (single-link form when GN lists one source).
 *
 * Also: the per-topic headline feeds (WORLD, BUSINESS, …) as a broader tail
 * supply — round-robin interleaved so no topic dominates, cross-feed
 * near-duplicates collapsed (trigram, first wins). See fetchTopicStories.
 */
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import { trigramSimilarity } from "../primitives";

export interface GnEdition {
  hl: string;
  gl: string;
  ceid: string;
}

export const GN_US: GnEdition = { hl: "en-US", gl: "US", ceid: "US:en" };

export interface CoverageEntry {
  headline: string;
  outlet: string;
}

export interface TrendingStory {
  rank: number;
  headline: string;
  leadOutlet: string;
  coverage: CoverageEntry[];
  /** Set by the host's velocity tripwire (see markBreaking in
   *  examples/run-news-desk.ts), not by any feed — Google News publishes a
   *  ranking, never a rate of climb. */
  breaking?: boolean;
  /** Publisher home page from the item's `<source url="…">` attribute. The
   *  only real host GN gives us — the item <link> is a JS stub. "" when the
   *  feed shape carries no source tag (top-stories items often don't). */
  sourceUrl?: string;
}

export function googleNewsTopUrl(edition: GnEdition): string {
  return `https://news.google.com/rss?hl=${edition.hl}&gl=${edition.gl}&ceid=${encodeURIComponent(edition.ceid)}`;
}

const parser = new Parser({ timeout: 15_000 });

function splitLeadTitle(raw: string): { headline: string; leadOutlet: string } {
  const at = raw.lastIndexOf(" - ");
  if (at === -1) return { headline: raw.trim(), leadOutlet: "" };
  return { headline: raw.slice(0, at).trim(), leadOutlet: raw.slice(at + 3).trim() };
}

function parseCoverage(descriptionHtml: string): CoverageEntry[] {
  const $ = cheerio.load(descriptionHtml);
  const items = $("li").length > 0 ? $("li").toArray() : [$.root()[0]];
  const coverage: CoverageEntry[] = [];
  for (const el of items) {
    const headline = $(el).find("a").first().text().trim();
    const outlet = $(el).find("font").first().text().trim();
    if (headline !== "") coverage.push({ headline, outlet });
  }
  return coverage;
}

export async function parseTrending(xml: string): Promise<TrendingStory[]> {
  const feed = await parser.parseString(xml);
  return feed.items.map((item, i) => {
    const { headline, leadOutlet } = splitLeadTitle(item.title ?? "");
    return {
      rank: i + 1,
      headline,
      leadOutlet,
      coverage: parseCoverage(item.content ?? ""),
    };
  });
}

export async function fetchTrendingStories(args: {
  edition: GnEdition;
  limit: number;
  fetchImpl?: typeof fetch;
}): Promise<TrendingStory[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(googleNewsTopUrl(args.edition), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`google-news: HTTP ${res.status} fetching top stories (${args.edition.ceid})`);
  }
  return (await parseTrending(await res.text())).slice(0, args.limit);
}

// ───────────────────────────────────────────────────────────────────────────
// Topic feeds — the tail supply. The top-stories list alone is thin and
// homogeneous (≈20 items, one editorial cluster), so after the covered-story
// ledger and the source floors a cycle regularly exhausts. Six per-topic
// headline feeds broaden it; interleaving + dedup keep the tail diverse.
// ───────────────────────────────────────────────────────────────────────────

export const GN_TOPICS = ["WORLD", "NATION", "BUSINESS", "TECHNOLOGY", "SCIENCE", "HEALTH"] as const;
export type GnTopic = (typeof GN_TOPICS)[number];

export function googleNewsTopicUrl(topic: GnTopic, edition: GnEdition): string {
  return `https://news.google.com/rss/headlines/section/topic/${topic}?hl=${edition.hl}&gl=${edition.gl}&ceid=${encodeURIComponent(edition.ceid)}`;
}

/** Topic items carry a <source url="…">Outlet</source> tag; a second parser
 *  instance maps it through (the shared one stays byte-identical for
 *  parseTrending). xml2js yields {_: text, $: attrs} for an attributed tag —
 *  or a bare string when attribute-less; normalize both to the outlet name. */
const topicParser: Parser<Record<string, unknown>, { source?: unknown }> = new Parser({
  timeout: 15_000,
  customFields: { item: ["source"] },
});

function sourceOutlet(source: unknown): string {
  if (typeof source === "string") return source.trim();
  if (typeof source === "object" && source !== null) {
    const text = (source as { _?: unknown })._;
    if (typeof text === "string") return text.trim();
  }
  return "";
}

/** The `url` attribute of `<source url="https://www.reuters.com">Reuters</source>`.
 *  xml2js yields {_: text, $: attrs} for an attributed tag; a bare string means
 *  the feed sent no attribute. This host is the provenance key for coverage
 *  lookups — GN item links are JS stubs and carry no host. */
function sourceHomeUrl(source: unknown): string {
  if (typeof source === "object" && source !== null) {
    const attrs = (source as { $?: { url?: unknown } }).$;
    if (attrs !== undefined && typeof attrs.url === "string") return attrs.url.trim();
  }
  return "";
}

/** GN topic titles usually end " - Outlet"; strip the suffix ONLY when it
 *  matches the item's <source> outlet — a bare last-" - " split would eat
 *  real headline text ("Dow up 300 - a record"). */
function stripOutletSuffix(title: string, outlet: string): string {
  const trimmed = title.trim();
  const suffix = ` - ${outlet}`;
  return outlet !== "" && trimmed.endsWith(suffix)
    ? trimmed.slice(0, trimmed.length - suffix.length).trim()
    : trimmed;
}

/** One topic feed's XML → TrendingStory[] in feed order. Coverage comes from
 *  the same <description> cluster markup as top stories; when GN sends the
 *  single-link form with no parseable entries, the item covers itself. */
export async function parseTopicStories(xml: string): Promise<TrendingStory[]> {
  const feed = await topicParser.parseString(xml);
  return feed.items
    .map((item, i) => {
      const outlet = sourceOutlet(item.source);
      const headline = stripOutletSuffix(item.title ?? "", outlet);
      const parsed = parseCoverage(item.content ?? "");
      return {
        rank: i + 1,
        headline,
        leadOutlet: outlet,
        sourceUrl: sourceHomeUrl(item.source),
        coverage: parsed.length > 0 ? parsed : [{ headline, outlet }],
      };
    })
    .filter((story) => story.headline !== "");
}

/** Cross-feed near-duplicate collapse: keep the FIRST of any headline pair at
 *  or above the trigram threshold (so earlier supply wins), then re-rank to
 *  the surviving order. Pure — input untouched. */
// ponytail: O(n²) trigram scan — fine for the few hundred headlines a merge
// sees; index by first-token bucket if supply ever grows past thousands.
export function dedupeTrending(stories: readonly TrendingStory[], threshold: number): TrendingStory[] {
  const kept: TrendingStory[] = [];
  for (const story of stories) {
    if (kept.some((k) => trigramSimilarity(k.headline, story.headline) >= threshold)) continue;
    kept.push(story);
  }
  return kept.map((story, i) => ({ ...story, rank: i + 1 }));
}

/**
 * Fetch several topic feeds in parallel and merge them into one ranked list:
 * round-robin interleave across topics (WORLD[0], NATION[0], …, WORLD[1], …)
 * so no topic dominates, collapse cross-feed near-duplicates (first wins),
 * re-rank, cap at `limit`. Per-feed best-effort with loud logging — the
 * newswire rule: one dead topic must never kill the tail supply.
 */
export async function fetchTopicStories(args: {
  edition: GnEdition;
  topics: readonly GnTopic[];
  limit: number;
  /** trigramSimilarity floor for near-identical headlines (≈0.55). */
  dedupeThreshold: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}): Promise<TrendingStory[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const perTopic = await Promise.all(
    args.topics.map(async (topic): Promise<TrendingStory[]> => {
      try {
        const res = await fetchImpl(googleNewsTopicUrl(topic, args.edition), {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return await parseTopicStories(await res.text());
      } catch (err: unknown) {
        args.log?.(`google-news: topic feed FAILED ${topic} (${args.edition.ceid}): ${String(err)}`);
        return [];
      }
    }),
  );
  return dedupeTrending(interleave(perTopic), args.dedupeThreshold).slice(0, args.limit);
}

/** Round-robin: feeds[0][0], feeds[1][0], …, feeds[0][1], … — no feed dominates. */
function interleave(perFeed: readonly TrendingStory[][]): TrendingStory[] {
  const out: TrendingStory[] = [];
  const deepest = Math.max(0, ...perFeed.map((stories) => stories.length));
  for (let depth = 0; depth < deepest; depth += 1) {
    for (const stories of perFeed) {
      const story = stories[depth];
      if (story !== undefined) out.push(story);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Site feeds — trending BY newspaper. GN has no native "trending for outlet
// X" filter; the search RSS with a site: query IS that filter: GN
// relevance-ranks the outlet's last-day output (~100 items, vs ~15 on a
// typical outlet front-page RSS). Search items carry the same <source> tag
// and " - Outlet" title suffix as topic items, so parseTopicStories parses
// both.
// ───────────────────────────────────────────────────────────────────────────

export interface SiteQuery {
  /** Bare domain for the site: operator — subdomains match too. */
  domain: string;
  /** The paper's home edition; GN ranking and language follow it. */
  edition: GnEdition;
}

export function googleNewsSiteUrl(site: SiteQuery): string {
  const q = encodeURIComponent(`site:${site.domain} when:1d`);
  const e = site.edition;
  return `https://news.google.com/rss/search?q=${q}&hl=${e.hl}&gl=${e.gl}&ceid=${encodeURIComponent(e.ceid)}`;
}

/** fetchTopicStories' contract with one search feed per newspaper: parallel
 *  best-effort fetch (one dead paper never kills the tail), round-robin
 *  interleave so no outlet dominates, first-wins trigram dedupe, cap. */
export async function fetchSiteStories(args: {
  sites: readonly SiteQuery[];
  limit: number;
  /** trigramSimilarity floor for near-identical headlines (≈0.55). */
  dedupeThreshold: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}): Promise<TrendingStory[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const perSite = await Promise.all(
    args.sites.map(async (site): Promise<TrendingStory[]> => {
      try {
        const res = await fetchImpl(googleNewsSiteUrl(site), {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return await parseTopicStories(await res.text());
      } catch (err: unknown) {
        args.log?.(`google-news: site feed FAILED ${site.domain} (${site.edition.ceid}): ${String(err)}`);
        return [];
      }
    }),
  );
  return dedupeTrending(interleave(perSite), args.dedupeThreshold).slice(0, args.limit);
}

// ───────────────────────────────────────────────────────────────────────────
// Coverage lookup — WHO is covering one story, from Google News rather than
// from an open web search.
//
// This is the source-discovery channel (operator, 2026-08-16: "for search hunt
// we either need to use datagod or google news rss"). The old hunt asked a web
// search engine for the story and admitted whatever hosts came back, which is
// how a WordPress site calling itself "Telegraph Online" ended up cited. Google
// News only indexes publishers it has admitted to its news index, so its
// coverage cluster is a vetted list of outlets by construction — and each item
// carries the outlet's OWN headline, which is what the desk needs to resolve a
// scrapable URL.
//
// What this deliberately does NOT do: follow the <link>. GN item links are
// JS-redirect stubs that stay on news.google.com when fetched (verified again
// 2026-08-16), so they are never decoded and never scraped. The host and the
// headline are the payload.
// ───────────────────────────────────────────────────────────────────────────

export interface Coverage {
  /** Publisher display name, e.g. "Reuters". */
  outlet: string;
  /** Publisher host without www., e.g. "reuters.com" — the provenance key. */
  host: string;
  /** That outlet's own headline for the story. */
  headline: string;
}

/** Host of a URL without www./m., or "" when unparseable. */
function bareHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m|amp|edition|mobile)\./, "");
  } catch {
    return "";
  }
}

export function googleNewsQueryUrl(query: string, edition: GnEdition, freshness: string): string {
  const q = encodeURIComponent(`${query} ${freshness}`.trim());
  return `https://news.google.com/rss/search?q=${q}&hl=${edition.hl}&gl=${edition.gl}&ceid=${encodeURIComponent(edition.ceid)}`;
}

/** Strip CDATA and decode the handful of entities a feed title can carry. */
function feedText(raw: string): string {
  return raw
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Coverage straight out of the search-RSS XML.
 *
 * Deliberately NOT via rss-parser: it flattens `<source url="…">Reuters</source>`
 * to the string "Reuters" and drops the url attribute — which is the ONLY host
 * Google News gives us, since item links are JS stubs. Reading it through the
 * parser returned an empty cluster for every story and the desk silently fell
 * back to the index alone (caught on the first live rewrite, 2026-08-16). The
 * shape is small and fixed, so it is parsed here and pinned by a check.
 */
export function parseCoverageFeed(xml: string): Coverage[] {
  const out: Coverage[] = [];
  const seen = new Set<string>();
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const src = /<source\s+url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/.exec(block);
    const title = /<title>([\s\S]*?)<\/title>/.exec(block);
    if (src === null || title === null) continue;
    const host = bareHost(src[1]);
    const outlet = feedText(src[2]);
    // GN titles end " - Outlet"; strip only when it IS this item's outlet, so
    // real headline text containing " - " survives.
    let headline = feedText(title[1]);
    const suffix = ` - ${outlet}`;
    if (outlet !== "" && headline.endsWith(suffix)) headline = headline.slice(0, -suffix.length).trim();
    if (host === "" || headline === "" || seen.has(host)) continue;
    seen.add(host);
    out.push({ outlet: outlet === "" ? host : outlet, host, headline });
  }
  return out;
}

/**
 * Which outlets are covering this story, per Google News. Best-effort: a failed
 * or empty lookup returns [] and the caller falls back to the outlet index
 * alone — discovery must never be able to kill a run.
 */
export async function fetchCoverage(args: {
  headline: string;
  edition: GnEdition;
  /** GN freshness operator, e.g. "when:2d". "" searches all time. */
  freshness?: string;
  limit: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}): Promise<Coverage[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = googleNewsQueryUrl(args.headline, args.edition, args.freshness ?? "when:7d");
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseCoverageFeed(await res.text()).slice(0, args.limit);
  } catch (err: unknown) {
    args.log?.(`google-news: coverage lookup failed for "${args.headline}" (best-effort): ${String(err)}`);
    return [];
  }
}
