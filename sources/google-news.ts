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
  const interleaved: TrendingStory[] = [];
  const deepest = Math.max(0, ...perTopic.map((stories) => stories.length));
  for (let depth = 0; depth < deepest; depth += 1) {
    for (const stories of perTopic) {
      const story = stories[depth];
      if (story !== undefined) interleaved.push(story);
    }
  }
  return dedupeTrending(interleaved, args.dedupeThreshold).slice(0, args.limit);
}
