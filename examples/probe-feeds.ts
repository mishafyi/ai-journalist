/**
 * probe-feeds.ts — scrape up to THREE articles per candidate outlet through
 * the operator's Firecrawl; print a per-outlet rate verdict. One draw is a
 * coin flip on a metered paywall; three read as a rate.
 *
 *   PASS    every sample scraped clean → keep in FEEDS
 *   PARTIAL some did (metered paywall / flaky antibot) → KEEP: the runtime
 *           drops teaser pages per-article (content-quality floor,
 *           news-desk.ts) and the search hunt backfills, so a partial
 *           outlet still contributes its free share
 *   FAIL    none did → do not put it in your feed list
 *
 *   FIRECRAWL_API_URL=… FIRECRAWL_API_KEY=… npx tsx examples/probe-feeds.ts \
 *     [url[,outlet[,region]] …]        (no args → a three-outlet demo set)
 *
 * Without FIRECRAWL_API_URL it prints a SKIP line and exits 0 (this example
 * makes live calls), so it is safe to run anywhere.
 */
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import { createNewswire, type OutletFeed } from "../sources/newswire";
import { isTeaserContent } from "../research";

/** A SHORT default so `npx tsx examples/probe-feeds.ts` does something useful
 *  with no arguments. Your own list goes on the command line — this is a tool
 *  for vetting feeds you are considering, not a curated set to inherit. */
const DEFAULT_FEEDS: OutletFeed[] = [
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", outlet: "BBC", region: "EU" },
  { url: "https://www.theguardian.com/world/rss", outlet: "The Guardian", region: "EU" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", outlet: "Al Jazeera", region: "MENA" },
];

/**
 * Feeds to probe: `url[,outlet[,region]]` per argument, else the defaults.
 *
 *   npx tsx examples/probe-feeds.ts https://example.com/rss,Example,US
 */
export function feedsFromArgv(argv: readonly string[]): OutletFeed[] {
  const parsed = argv
    .filter((a) => a.startsWith("http"))
    .map((a) => {
      const [url, outlet, region] = a.split(",");
      return { url, outlet: outlet ?? new URL(url).hostname.replace(/^www\./, ""), region: region ?? "" };
    });
  return parsed.length > 0 ? parsed : DEFAULT_FEEDS;
}

async function main(): Promise<void> {
  if (!process.env.FIRECRAWL_API_URL) {
    process.stdout.write(
      "SKIP probe-feeds — FIRECRAWL_API_URL not set (this example makes live calls)\n",
    );
    return;
  }

  const search = createFirecrawlSearch({
    apiKey: process.env.FIRECRAWL_API_KEY,
    apiUrl: process.env.FIRECRAWL_API_URL,
  });
  const feeds = feedsFromArgv(process.argv.slice(2));
  const wire = createNewswire({
    feeds, concurrency: 4, timeoutMs: 15_000,
    log: (l) => process.stdout.write(l + "\n"),
  });
  const index = await wire.buildIndex();
  for (const feed of feeds) {
    const items = index.filter((i) => i.outlet === feed.outlet);
    if (items.length === 0) {
      process.stdout.write(`FAIL    ${feed.outlet} — feed yielded no linked items\n`);
      continue;
    }
    // First / middle / last of the outlet's feed window — spread the draws so
    // one promoted-free lead article can't flatter a paywalled catalogue.
    const picks = [...new Set([0, Math.floor(items.length / 2), items.length - 1])].map((i) => items[i]);
    const errors: string[] = [];
    const results = await Promise.all(
      picks.map(async (item): Promise<"clean" | "teaser" | "error"> => {
        try {
          const content = (await search.scrape?.(item.url)) ?? "";
          return isTeaserContent(content, 400) ? "teaser" : "clean";
        } catch (err: unknown) {
          errors.push(`${item.url}: ${String(err).slice(0, 80)}`);
          return "error";
        }
      }),
    );
    const clean = results.filter((r) => r === "clean").length;
    const teaser = results.filter((r) => r === "teaser").length;
    const verdict = clean === results.length ? "PASS   " : clean > 0 ? "PARTIAL" : "FAIL   ";
    const counts = `${clean}/${results.length} clean, ${teaser} teaser, ${results.length - clean - teaser} error`;
    const firstError = errors.length > 0 ? ` — ${errors[0]}` : "";
    process.stdout.write(`${verdict} ${feed.outlet} — ${counts}${firstError}\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`probe-feeds failed: ${String(err)}\n`);
  process.exit(1);
});
