/**
 * News-source helpers for the blog generator.
 *
 * Two responsibilities:
 *  1. RSS fetch + parse via `rss-parser` (replaces the hand-rolled regex parser
 *     `parseNewsRss` — see project rule: don't hand-roll what a lib does).
 *  2. The shared antibot/paywall host skip-list — hosts that always reject the
 *     scraper (paywalled majors + `.mil`), so callers can skip them up front
 *     instead of burning scrape attempts. Mirrors `CHASE_SKIP_HOSTS` in
 *     the host adapter but extended to ALL news fetches, not just the primary-chase.
 *
 * Google News RSS carries NO article body — only the headline + a redirect link
 * (the `<description>` is just the headline as an `<a>`). So RSS gives discovery
 * SIGNAL, never grounding; grounding still comes from scraping scrapable hosts.
 */
import Parser from "rss-parser";

/**
 * The engine's STABLE default blocked-host list (paywalled majors). Suffix match
 * covers subdomains. The engine reads NO env: the adapter owns the
 * `BLOG_BLOCKED_HOSTS` override and passes the resolved list into `isBlockedHost`.
 */
export const DEFAULT_BLOCKED_HOSTS: readonly string[] = [
  "wsj.com",
  "bloomberg.com",
  "nytimes.com",
  "reuters.com",
  "ft.com",
  "mckinsey.com",
];

/**
 * True for hosts that reliably block the scraper (paywall/antibot/.mil). The
 * blocked-host list is a PARAMETER (the engine reads no env); pass
 * `DEFAULT_BLOCKED_HOSTS` for the engine default, or the adapter's
 * `BLOG_BLOCKED_HOSTS`-derived list.
 */
export function isBlockedHost(
  host: string,
  blockedHosts: readonly string[],
): boolean {
  const h = host.replace(/^www\./, "").toLowerCase();
  return (
    h.endsWith(".mil") ||
    blockedHosts.some((b) => h === b || h.endsWith(`.${b}`))
  );
}

// Google News RSS puts the publisher in a non-standard <source> element that
// rss-parser ignores by default; the customField surfaces its text as
// `sourceName` (e.g. "Business Insider"). Matches what the old regex captured.
type NewsCustom = { sourceName?: string };
const rss = new Parser<unknown, NewsCustom>({
  timeout: 15_000,
  customFields: { item: [["source", "sourceName"]] },
});

const googleNewsRssUrl = (query: string): string =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(
    query,
  )}&hl=en-US&gl=US&ceid=US:en`;

export interface RssHeadline {
  title: string;
  source: string;
  date: string;
}

/**
 * Fetch Google-News-RSS headlines for a query (lib does fetch + parse).
 * Headlines only — cheap discovery signal, NOT grounding (the feed has no
 * article body). Best-effort: returns [] on any failure (rate-limit, network).
 */
export async function fetchRssHeadlines(
  query: string,
  limit: number,
): Promise<RssHeadline[]> {
  try {
    const feed = await rss.parseURL(googleNewsRssUrl(query));
    return feed.items
      .slice(0, limit)
      .map((i) => ({
        title: (i.title ?? "").trim(),
        source: (i.sourceName ?? "").trim(),
        date: (i.pubDate ?? "").trim(),
      }))
      .filter((i) => i.title);
  } catch {
    return [];
  }
}

export interface RssItem {
  title: string;
  link: string;
  date: string;
  source: string;
}

/**
 * Parse already-fetched RSS XML into news items (drop-in for `parseNewsRss`):
 * `{title, link, date, source}`, link-less items dropped. `source` is the
 * publisher name from <source> (matches the old regex's text capture).
 */
export async function parseRssTitles(xml: string): Promise<RssItem[]> {
  const feed = await rss.parseString(xml);
  return feed.items
    .map((i) => ({
      title: (i.title ?? "").trim(),
      link: (i.link ?? "").trim(),
      date: (i.pubDate ?? "").trim(),
      source: (i.sourceName ?? "").trim(),
    }))
    .filter((i) => i.link);
}
