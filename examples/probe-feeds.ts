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
 *   FAIL    none did → prune from FEEDS (examples/run-news-desk.ts)
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
  { url: "https://abcnews.go.com/abcnews/topstories", outlet: "ABC News", region: "US" },
  { url: "https://www.cbsnews.com/latest/rss/main", outlet: "CBS News", region: "US" },
  { url: "https://feeds.skynews.com/feeds/rss/home.xml", outlet: "Sky News", region: "EU" },
  { url: "https://www.euronews.com/rss", outlet: "Euronews", region: "EU" },
  { url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", outlet: "Times of India", region: "Asia" },
  // Non-English batch 2026-08-10 — mirrors the FEEDS additions in run-news-desk.ts.
  { url: "https://www.lemonde.fr/rss/une.xml", outlet: "Le Monde", region: "EU" },
  { url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada", outlet: "El País", region: "EU" },
  { url: "https://www.spiegel.de/schlagzeilen/index.rss", outlet: "Der Spiegel", region: "EU" },
  { url: "https://xml2.corriereobjects.it/rss/homepage.xml", outlet: "Corriere della Sera", region: "EU" },
  { url: "https://g1.globo.com/rss/g1/", outlet: "G1 Globo", region: "LatAm" },
  { url: "https://www.clarin.com/rss/lo-ultimo/", outlet: "Clarín", region: "LatAm" },
  { url: "https://www.yna.co.kr/rss/news.xml", outlet: "Yonhap", region: "Asia" },
  { url: "https://www3.nhk.or.jp/rss/news/cat0.xml", outlet: "NHK", region: "Asia" },
  { url: "https://aawsat.com/feed", outlet: "Asharq Al-Awsat", region: "MENA" },
  { url: "https://www.hurriyet.com.tr/rss/anasayfa", outlet: "Hürriyet", region: "MENA" },
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
