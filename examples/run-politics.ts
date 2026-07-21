/**
 * run-politics.ts — operator-run test: hot US/EU political news, written by a
 * LOCAL model (gemma4:e4b on the Mac mini via Ollama) through the full
 * newsroom pipeline (discovery → research → sections → editor + gate chain).
 *
 *   FIRECRAWL_API_URL=… FIRECRAWL_API_KEY=… npx tsx run-politics.ts
 *
 * Output: out/<slug>.md — DRAFT, never published anywhere.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
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
      return {
        ...signal,
        framing:
          "US and European political news, last 24-48h. Pick the SINGLE hottest named political story from the signal items — an election, government decision, legislation, diplomatic clash, or scandal that is happening NOW. The article must be about that specific event and its players, not a general theme or explainer.",
      };
    },
    async coveredTopics(): Promise<CoveredTopic[]> {
      let files: string[];
      try {
        files = await readdir("out");
      } catch {
        return [];
      }
      const covered: CoveredTopic[] = [];
      for (const f of files.filter((f) => f.endsWith(".md"))) {
        const slug = f.replace(/\.md$/, "");
        const info = await stat(`out/${f}`);
        covered.push({
          title: slug.replace(/-/g, " "),
          slug,
          date: info.mtime.toISOString(),
        });
      }
      return covered;
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
    searchDefaults: { sources: ["news"] },
  });
  const stack = createResearchStack({ search });
  const source = createPoliticsSource();

  const sink: Sink = {
    async publish(post: GeneratedPost): Promise<PublishResult> {
      await mkdir("out", { recursive: true });
      const path = `out/${post.slug}.md`;
      await writeFile(path, post.markdown);
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
    // raw client the stack wraps).
    gatherResearch: createExtractiveResearch({
      llm,
      search,
      pagesPerTopic: 3,
      chunkChars: 24_000,
      maxChunksPerPage: 4,
      minContentChars: 400,
      log: (l) => process.stdout.write(l + "\n"),
    }),
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
