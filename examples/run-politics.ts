/**
 * run-politics.ts — operator-run test: hot US/EU political news, written by a
 * LOCAL model (gemma4:e4b on the Mac mini via Ollama) through the full
 * newsroom pipeline (discovery → research → sections → editor + gate chain).
 *
 *   FIRECRAWL_API_URL=… FIRECRAWL_API_KEY=… npx tsx run-politics.ts
 *
 * Output: out/<slug>.md — DRAFT, never published anywhere.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { runPipeline } from "../index";
import { createDefaultInternals } from "../presets/default";
import { createExtractiveResearch, createResearchStack } from "../research";
import { createOllamaLlm } from "../clients/ollama-llm";
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import { createRssSource } from "../sources/rss";
import type {
  BrandProfile,
  CoveredTopic,
  DiscoverySignal,
  GeneratedPost,
  PublishResult,
  Sink,
  Source,
} from "../ports";

const brand: BrandProfile = {
  name: "Transatlantic Brief",
  publication: "Transatlantic Brief (example.com)",
  beat: "US and European politics",
  desk: "a transatlantic political news desk covering Washington, Brussels, and European capitals",
  bylines: ["Staff Writer"],
};

/** Political wires, US + Europe. */
const FEEDS: string[] = [
  "https://rss.politico.com/politics-news.xml",
  "https://www.politico.eu/feed/",
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://www.theguardian.com/world/rss",
];

/** RSS source wrapped to add framing the discovery prompts read, plus
 *  covered-topics memory from out/*.md so a scheduled loop moves to the NEXT
 *  trending story instead of rewriting yesterday's (slug → approximate title;
 *  discovery dedup is trigram/embedding-based, so hyphens→spaces suffices). */
function createPoliticsSource(): Source {
  const rss = createRssSource({ feeds: FEEDS });
  return {
    async gatherSignal(): Promise<DiscoverySignal> {
      const signal = await rss.gatherSignal();
      const today = new Date().toISOString().slice(0, 10);
      return {
        ...signal,
        framing:
          `Today is ${today}. US and European political news, last 24-48h. Pick the SINGLE hottest named political story from the signal items — an election, government decision, legislation, diplomatic clash, or scandal that is happening NOW. The article must be about that specific event and its players, not a general theme or explainer. Events older than about 7 days are background context only — never present them as the breaking story.`,
      };
    },
    async coveredTopics(): Promise<CoveredTopic[]> {
      // Primary: the publish-time ledger (real titles). Fallback: slug-derived
      // titles for legacy articles that predate the ledger. Dedupe by slug.
      const bySlug = new Map<string, CoveredTopic>();
      try {
        const ledger = JSON.parse(await readFile("out/covered.json", "utf8")) as CoveredTopic[];
        for (const c of ledger) if (c.slug !== undefined) bySlug.set(c.slug, c);
      } catch {
        // no ledger yet — legacy fallback below covers it
      }
      let files: string[] = [];
      try {
        files = await readdir("out");
      } catch {
        return [...bySlug.values()];
      }
      for (const f of files.filter((f) => f.endsWith(".md"))) {
        const slug = f.replace(/\.md$/, "");
        if (bySlug.has(slug)) continue;
        const info = await stat(`out/${f}`);
        bySlug.set(slug, {
          title: slug.replace(/-/g, " "),
          slug,
          date: info.mtime.toISOString(),
        });
      }
      return [...bySlug.values()];
    },
  };
}

async function main(): Promise<void> {
  const llm = createOllamaLlm({
    baseUrl: "http://localhost:11434",
    model: "gemma4:e4b",
    options: { numCtx: 32768, keepAlive: "30m" },
  });
  const search = createFirecrawlSearch({
    apiKey: process.env.FIRECRAWL_API_KEY,
    apiUrl: process.env.FIRECRAWL_API_URL,
    // qdr:w = past-week freshness filter — live-verified non-zeroing on the
    // SearXNG-backed self-hosted /v2/search (2026-07-21).
    searchDefaults: { sources: ["news"], tbs: "qdr:w" },
  });
  const stack = createResearchStack({ search });
  const source = createPoliticsSource();

  /** Every source the deep research contributed this run — the sink publishes
   *  them alongside the article so attribution is visible on the site. */
  const runSources: { title: string; url: string }[] = [];
  const seenSourceUrls = new Set<string>();
  const recordSources = (sources: { title: string; url: string }[]): void => {
    for (const s of sources) {
      if (seenSourceUrls.has(s.url)) continue;
      seenSourceUrls.add(s.url);
      runSources.push(s);
    }
  };

  const sink: Sink = {
    async publish(post: GeneratedPost): Promise<PublishResult> {
      await mkdir("out", { recursive: true });
      const path = `out/${post.slug}.md`;
      await writeFile(path, post.markdown);
      await writeFile(`out/${post.slug}.sources.json`, JSON.stringify(runSources, null, 2));
      // Publish-time covered ledger: REAL titles for future runs' dedup.
      let ledger: { title: string; slug: string; date: string }[] = [];
      try {
        ledger = JSON.parse(await readFile("out/covered.json", "utf8"));
      } catch {
        // first run — fresh ledger
      }
      ledger.push({ title: post.title, slug: post.slug, date: new Date().toISOString() });
      await writeFile("out/covered.json", JSON.stringify(ledger, null, 2));
      return { url: path, status: "DRAFT" };
    },
  };

  const internals = createDefaultInternals({
    llm,
    // Hardened facade: sanitize+throttle+breaker on every engine search —
    // discovery snippets included (the junk-query incident's actual path).
    search: stack.asSearchClient(),
    brand,
    source,
    // Binds run telemetry into the stack and wires retryThin backfill.
    research: stack,
    // Explicit gatherResearch wins over the stack's: sections stay on the
    // full-scrape + chunked-extraction path (scrapes its own pages via the
    // raw client the stack wraps). Wrapped to accumulate contributing sources
    // for the sink's sources.json.
    gatherResearch: (() => {
      const extractive = createExtractiveResearch({
        llm,
        // Through the hardened facade — section-topic queries get the
        // sanitizer/throttle/breaker too (raw client here let junk queries
        // reach search and dictionary pages into published sources, 2026-07-21).
        search: stack.asSearchClient(),
        pagesPerTopic: 3,
        chunkChars: 24_000,
        maxChunksPerPage: 4,
        minContentChars: 400,
        log: (l) => process.stdout.write(l + "\n"),
      });
      return async (topic: string) => {
        const result = await extractive(topic);
        recordSources(result.sources);
        return result;
      };
    })(),
  });

  const post = await runPipeline({
    source,
    sink,
    config: { llm, search, brand },
    internals,
    dryRun: false,
  });

  process.stdout.write(`Published "${post.title}" → out/${post.slug}.md [DRAFT]\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`run-politics failed: ${String(err)}\n`);
  process.exit(1);
});
