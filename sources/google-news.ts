/**
 * Google News Top-Stories RSS → ranked, PRE-CLUSTERED trending stories.
 * Extends news.ts's validated fetch pattern (15s timeout). GN item links are
 * JS-redirect stubs — NEVER decoded, NEVER scraped (per spec); resolution
 * happens by headline-matching against our own outlet feeds (matching.ts).
 * The <description> carries the coverage list: <ol><li><a>headline</a>
 * <font>Outlet</font></li>… (single-link form when GN lists one source).
 */
import Parser from "rss-parser";
import * as cheerio from "cheerio";

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
