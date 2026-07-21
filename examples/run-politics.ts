/**
 * run-politics.ts — operator-run test: hot US/EU political news, written by a
 * LOCAL model (gemma4:e4b on the Mac mini via Ollama) through the full
 * newsroom pipeline (discovery → research → sections → editor + gate chain).
 *
 *   FIRECRAWL_API_URL=… FIRECRAWL_API_KEY=… npx tsx run-politics.ts
 *
 * Output: out/<slug>.md — DRAFT, never published anywhere.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { runPipeline } from "../index";
import { createDefaultInternals } from "../presets/default";
import { createOllamaLlm } from "../clients/ollama-llm";
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import { createRssSource } from "../sources/rss";
import type {
  BrandProfile,
  DiscoverySignal,
  GeneratedPost,
  LlmClient,
  PublishResult,
  SearchClient,
  Sink,
  Source,
} from "../ports";

/** Deep research: pages per section topic, and how a long page is split across
 *  extraction calls (the model can't hold a full page + prompt at once, so each
 *  chunk gets its own call — full content is always processed, never truncated). */
const PAGES_PER_TOPIC = 3;
const CHUNK_CHARS = 24_000;
const MAX_CHUNKS_PER_PAGE = 4;

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS_PER_PAGE; i += CHUNK_CHARS) {
    chunks.push(text.slice(i, i + CHUNK_CHARS));
  }
  return chunks;
}

/** Scrape the top hits for a topic in full and LLM-extract the evidence
 *  (facts, figures, dates, named people, verbatim quotes) chunk by chunk. */
function createScrapeResearch(args: {
  llm: LlmClient;
  search: SearchClient;
}): (topic: string) => Promise<{ block: string }> {
  const { llm, search } = args;
  if (search.scrape === undefined) {
    throw new Error("createScrapeResearch: the SearchClient does not implement scrape()");
  }
  const scrape = search.scrape.bind(search);

  return async (topic: string): Promise<{ block: string }> => {
    const hits = await search.search(topic, { limit: PAGES_PER_TOPIC });
    const sources: string[] = [];
    for (const hit of hits) {
      let content = "";
      try {
        content = await scrape(hit.url);
      } catch (err: unknown) {
        process.stdout.write(
          `        deep-scrape FAILED ${hit.url}: ${String(err)} — using snippet\n`,
        );
        sources.push(`- ${hit.title}: ${hit.snippet}`);
        continue;
      }
      const chunks = chunkText(content);
      process.stdout.write(
        `        deep-scrape ${hit.url} (${content.length} chars, ${chunks.length} extraction calls)\n`,
      );
      const parts: string[] = [];
      for (const [i, chunk] of chunks.entries()) {
        const extracted = await llm.complete({
          system:
            "You extract evidence for a news article. From the page text, list every concrete fact, statistic, date, named person or institution, and direct quote (verbatim, in quotation marks, with who said it) relevant to the topic. Dense bullet points only, no commentary. If nothing is relevant, reply exactly: NONE",
          prompt: `TOPIC: ${topic}\n\nPAGE ${hit.url} (part ${i + 1}/${chunks.length}):\n${chunk}`,
          temperature: 0.1,
        });
        if (extracted.trim() !== "NONE") {
          parts.push(extracted.trim());
        }
      }
      if (parts.length > 0) {
        sources.push(`SOURCE ${hit.title} (${hit.url}):\n${parts.join("\n")}`);
      }
    }
    return { block: sources.join("\n\n") };
  };
}

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

/** RSS source wrapped to add framing the discovery prompts read. */
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
  };
}

async function main(): Promise<void> {
  const llm = createOllamaLlm({
    baseUrl: "http://localhost:11434",
    model: "gemma4:e4b",
  });
  const search = createFirecrawlSearch({
    apiKey: process.env.FIRECRAWL_API_KEY,
    apiUrl: process.env.FIRECRAWL_API_URL,
  });
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
    search,
    brand,
    source,
    gatherResearch: createScrapeResearch({ llm, search }),
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
