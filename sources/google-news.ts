/**
 * Google News Top-Stories RSS → ranked, PRE-CLUSTERED trending stories.
 * Extends news.ts's validated fetch pattern (15s timeout). GN item links are
 * opaque stubs; resolution happens by headline-matching against our own outlet
 * feeds (matching.ts), and for a story's wider coverage by decoding the stub
 * (`resolveCoverageUrl`). A stub is NEVER scraped as itself and never confers
 * admissibility — the host from <source url> decides that, before any decode.
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

/** Google News's own "Top stories" section, which the bare feed is only a
 *  slice of: measured 2026-08-31, 70 items against the bare feed's 38, sharing
 *  just 14 headlines — and carrying the same clustered shape (lead outlet,
 *  <source url>, the coverage <ol> in the description). Any section's id is
 *  the path segment of its news.google.com/topics/<id> URL. */
export const GN_TOP_STORIES = "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB";

export function googleNewsTopicIdUrl(topicId: string, edition: GnEdition): string {
  return `https://news.google.com/rss/topics/${encodeURIComponent(topicId)}?hl=${edition.hl}&gl=${edition.gl}&ceid=${encodeURIComponent(edition.ceid)}`;
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
  /** A section id (see GN_TOP_STORIES) to read that section's feed instead of
   *  the bare top-stories one. Same item shape either way. */
  topicId?: string;
  fetchImpl?: typeof fetch;
}): Promise<TrendingStory[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url =
    args.topicId === undefined || args.topicId === ""
      ? googleNewsTopUrl(args.edition)
      : googleNewsTopicIdUrl(args.topicId, args.edition);
  const res = await fetchImpl(url, {
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
// The <link> is an opaque stub, but no longer a dead end: `resolveCoverageUrl`
// turns it into the publisher URL (see there). The host and the headline
// remain the payload that discovery is built on — a decode is an optimisation
// over searching for a URL we were already told exists, never the thing that
// decides an outlet is admissible.
// ───────────────────────────────────────────────────────────────────────────

export interface Coverage {
  /** Publisher display name, e.g. "Reuters". */
  outlet: string;
  /** Publisher host without www., e.g. "reuters.com" — the provenance key. */
  host: string;
  /** That outlet's own headline for the story. */
  headline: string;
  /** The item's `news.google.com/rss/articles/…` link. Opaque on its own —
   *  feed it to `resolveCoverageUrl` to get the publisher URL. */
  stub: string;
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

/** A `<source>` element as rss-parser hands it back with `keepArray: true`:
 *  the text in `_`, the attributes in `$`. */
interface RssSourceNode {
  _?: string;
  $?: { url?: string };
}

/** Parser that KEEPS `<source>` as a node instead of flattening it.
 *
 *  The url attribute is the only host Google News gives us — item links are JS
 *  stubs — and `customFields: { item: ["source"] }` (what the topic parser
 *  above uses) collapses the element to its text, "Reuters", losing it. That
 *  cost a day: coverage came back empty for every story and the desk silently
 *  fell back to the outlet index (2026-08-16). `keepArray` returns
 *  `[{ _: "Reuters", $: { url: "https://www.reuters.com" } }]`, attribute
 *  intact — so this is a stock rss-parser feature, not a library limitation,
 *  and there is no reason to hand-roll XML for it. */
const coverageParser: Parser<Record<string, unknown>, { source?: RssSourceNode[] }> = new Parser({
  timeout: 15_000,
  customFields: { item: [["source", "source", { keepArray: true }]] },
});

/**
 * Coverage straight out of the search-RSS XML. rss-parser handles CDATA,
 * entity decoding and attribute quoting, so none of that is re-implemented
 * here. A malformed feed yields [] rather than throwing — discovery must never
 * be able to kill a run.
 */
export async function parseCoverageFeed(xml: string): Promise<Coverage[]> {
  const out: Coverage[] = [];
  const seen = new Set<string>();
  let items: { title?: string; link?: string; source?: RssSourceNode[] }[];
  try {
    items = (await coverageParser.parseString(xml)).items ?? [];
  } catch {
    return out;
  }
  for (const item of items) {
    const node = Array.isArray(item.source) ? item.source[0] : undefined;
    const host = bareHost(String(node?.$?.url ?? ""));
    const outlet = String(node?._ ?? "").trim();
    // GN titles end " - Outlet"; strip only when it IS this item's outlet, so
    // real headline text containing " - " survives.
    let headline = String(item.title ?? "").trim();
    const suffix = ` - ${outlet}`;
    if (outlet !== "" && headline.endsWith(suffix)) headline = headline.slice(0, -suffix.length).trim();
    if (host === "" || headline === "" || seen.has(host)) continue;
    seen.add(host);
    out.push({ outlet: outlet === "" ? host : outlet, host, headline, stub: String(item.link ?? "").trim() });
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
    return (await parseCoverageFeed(await res.text())).slice(0, args.limit);
  } catch (err: unknown) {
    args.log?.(`google-news: coverage lookup failed for "${args.headline}" (best-effort): ${String(err)}`);
    return [];
  }
}

// ─── Stub → publisher URL ───────────────────────────────────────────────────
// A coverage item's <link> is `news.google.com/rss/articles/<blob>`, and the
// blob is opaque: base64-decoding it yields a protobuf whose payload is an
// `AU_yqL…` token with no URL in it (re-checked 2026-09-03 — this is why the
// older "never decoded" note was true when written). The URL is obtained the
// way Google's own front end obtains it: read a signature and timestamp off
// the stub page, then ask the batchexecute RPC to resolve them.
//
// WHY BOTHER, when the hunt could just search for it: because we are not
// looking for a page, we already know the page exists and who published it.
// Searching re-asks a third party to find a URL Google just handed us a
// receipt for, and that third party is the least reliable link in the chain —
// on 2026-09-03 DuckDuckGo answered every `site:` query with an anti-bot page
// and the desk published nothing for a day. Decoding measured 12/12 that same
// afternoon, fired back to back with no pacing and no blocks.
//
// THIS IS A PRIVATE ENDPOINT. It carries no compatibility promise and will
// break without notice; that is a cost of the approach, not a surprise. Every
// failure path returns "" so the caller falls back to the search hunt, and
// nothing here can throw into a run.

/** Signature/timestamp the batchexecute call has to echo back. */
function stubCredentials(html: string): { signature: string; timestamp: string } | undefined {
  const signature = /data-n-a-sg="([^"]+)"/.exec(html)?.[1];
  const timestamp = /data-n-a-ts="([^"]+)"/.exec(html)?.[1];
  return signature === undefined || timestamp === undefined ? undefined : { signature, timestamp };
}

/** The one URL in a batchexecute response, which is escaped JSON inside JSON
 *  inside an anti-hijacking prelude — read the `garturlres` payload rather
 *  than JSON.parse-ing three layers to reach one string. */
function firstResolvedUrl(body: string): string {
  return /garturlres.{0,8}(https?:\/\/[^\\"]+)/.exec(body)?.[1] ?? "";
}

/**
 * Resolve a Google News coverage stub to the publisher's own article URL.
 *
 * Returns "" on ANY failure — a missing stub, a page without credentials, a
 * refused RPC, a response with no URL. The caller treats "" as "not resolved"
 * and falls back to searching, so a Google-side change degrades this to the
 * behaviour we had before it existed.
 */
export async function resolveCoverageUrl(args: {
  stub: string;
  edition: GnEdition;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}): Promise<string> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const blob = /\/articles\/([A-Za-z0-9_-]+)/.exec(args.stub)?.[1];
  if (blob === undefined) return "";
  try {
    const page = await fetchImpl(`https://news.google.com/rss/articles/${blob}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!page.ok) throw new Error(`stub page HTTP ${page.status}`);
    const creds = stubCredentials(await page.text());
    if (creds === undefined) throw new Error("stub page carried no signature");

    // The RPC argument is a fixed request envelope with the blob, timestamp
    // and signature slotted in; its shape is Google's, not ours, so it is
    // written out literally rather than modelled.
    const request = JSON.stringify([
      "garturlreq",
      [["X", "X", ["X", "X"], null, null, 1, 1, args.edition.ceid, null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      blob,
      Number(creds.timestamp),
      creds.signature,
    ]);
    const res = await fetchImpl("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ "f.req": JSON.stringify([[["Fbv4je", request]]]) }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`batchexecute HTTP ${res.status}`);
    const url = firstResolvedUrl(await res.text());
    if (url === "") throw new Error("batchexecute returned no url");
    return url;
  } catch (err: unknown) {
    args.log?.(`google-news: stub decode failed (falling back to search): ${String(err)}`);
    return "";
  }
}
