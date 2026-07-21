/**
 * probe-feeds.ts — scrape ONE article per candidate outlet through the
 * operator's Firecrawl; print PASS/TEASER/FAIL per outlet. The passing set
 * becomes the runner's FEEDS list (examples/run-news-desk.ts).
 *
 *   FIRECRAWL_API_URL=… FIRECRAWL_API_KEY=… npx tsx examples/probe-feeds.ts
 *
 * Without FIRECRAWL_API_URL it prints a SKIP line and exits 0 (this example
 * makes live calls), so it is safe to run anywhere.
 */
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import { createNewswire, type OutletFeed } from "../sources/newswire";
import { isTeaserContent } from "../research";

export const CANDIDATE_FEEDS: OutletFeed[] = [
  { url: "https://feeds.apnews.com/rss/apf-topnews", outlet: "AP News", region: "US" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", outlet: "BBC", region: "EU" },
  { url: "https://www.theguardian.com/world/rss", outlet: "The Guardian", region: "EU" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", outlet: "Al Jazeera", region: "MENA" },
  { url: "https://feeds.npr.org/1001/rss.xml", outlet: "NPR", region: "US" },
  { url: "https://rss.politico.com/politics-news.xml", outlet: "Politico", region: "US" },
  { url: "https://thehill.com/homenews/feed/", outlet: "The Hill", region: "US" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", outlet: "CNBC", region: "US" },
  { url: "https://rss.dw.com/rdf/rss-en-all", outlet: "DW", region: "EU" },
  { url: "https://www.france24.com/en/rss", outlet: "France 24", region: "EU" },
];

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
  const wire = createNewswire({
    feeds: CANDIDATE_FEEDS, concurrency: 4, timeoutMs: 15_000,
    log: (l) => process.stdout.write(l + "\n"),
  });
  const index = await wire.buildIndex();
  for (const feed of CANDIDATE_FEEDS) {
    const item = index.find((i) => i.outlet === feed.outlet);
    if (item === undefined) {
      process.stdout.write(`FAIL   ${feed.outlet} — feed yielded no linked items\n`);
      continue;
    }
    try {
      const content = (await search.scrape?.(item.url)) ?? "";
      const verdict = isTeaserContent(content, 400) ? "TEASER" : "PASS  ";
      process.stdout.write(`${verdict} ${feed.outlet} — ${content.length} chars (${item.url})\n`);
    } catch (err: unknown) {
      process.stdout.write(`FAIL   ${feed.outlet} — scrape: ${String(err).slice(0, 100)}\n`);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`probe-feeds failed: ${String(err)}\n`);
  process.exit(1);
});
