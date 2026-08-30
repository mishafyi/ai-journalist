/**
 * news-desk.ts — the smallest working news desk.
 *
 * `basic.ts` shows the generic pipeline: you bring a data signal, you get an
 * article. The NEWS desk is the other shape — it starts from what is trending,
 * resolves the story against outlet feeds you trust, and refuses to write
 * unless enough of them can actually be scraped.
 *
 * Three feeds and one columnist here, on purpose. A real masthead is dozens of
 * feeds and a roster, but that is YOUR editorial config, not something to
 * inherit from an example — swap `FEEDS` and `COLUMNIST` for your own and the
 * rest of this file stays the same.
 *
 *   OLLAMA_URL=http://localhost:11434 FIRECRAWL_API_URL=… FIRECRAWL_API_KEY=… \
 *     npx tsx examples/news-desk.ts
 *
 * Without the env it prints SKIP and exits 0, so it is safe to run anywhere.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { createNewsDesk } from "../presets/news-desk";
import { createOllamaLlm } from "../clients/ollama-llm";
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import type { OutletFeed } from "../sources/newswire";
import type { BrandProfile, GeneratedPost, PersonaProfile, PublishResult, Sink } from "../ports";

/** Outlets whose reporting the desk is willing to build a story on. Probe a
 *  candidate before adding it: `npx tsx examples/probe-feeds.ts <url>`. */
const FEEDS: OutletFeed[] = [
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", outlet: "BBC", region: "EU" },
  { url: "https://www.theguardian.com/world/rss", outlet: "The Guardian", region: "EU" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", outlet: "Al Jazeera", region: "MENA" },
];

/** Who writes. `method` and `priors` shape the argument, `voice` the prose —
 *  a persona is an editorial stance, not a costume. */
const COLUMNIST: PersonaProfile = {
  name: "Sam Rivera",
  method: "Follow the money and the paperwork. Prefer a filing to a quote.",
  priors: "Institutions fail in predictable ways; incentives explain more than intentions.",
  voice: "Plain, unhurried, allergic to adjectives. Short sentences carry the weight.",
};

const BRAND: BrandProfile = {
  name: "Example Wire",
  publication: "Example Wire (example.test)",
  beat: "world news",
  bylines: [COLUMNIST.name],
};

/** Writes the finished column to out/<slug>.md instead of publishing it — the
 *  Sink is the seam where your CMS goes. */
const fileSink: Sink = {
  async publish(post: GeneratedPost): Promise<PublishResult> {
    await mkdir("out", { recursive: true });
    const path = `out/${post.slug}.md`;
    await writeFile(path, `# ${post.title}\n\n${post.markdown}\n`, "utf8");
    process.stdout.write(`wrote ${path}\n`);
    return { url: path, status: "DRAFT" };
  },
};

async function main(): Promise<void> {
  if (process.env.FIRECRAWL_API_URL === undefined) {
    process.stdout.write("SKIP news-desk — set FIRECRAWL_API_URL (and OLLAMA_URL) to run it live\n");
    return;
  }

  const desk = createNewsDesk({
    llm: createOllamaLlm({
      baseUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
      model: process.env.OLLAMA_MODEL ?? "gemma3:12b",
      options: { numCtx: 32768, keepAlive: "30m" },
    }),
    search: createFirecrawlSearch({
      apiKey: process.env.FIRECRAWL_API_KEY,
      apiUrl: process.env.FIRECRAWL_API_URL,
    }),
    feeds: FEEDS,
    persona: COLUMNIST,
    brand: BRAND,
    sink: fileSink,
    authorVersions: { wordCap: 1100 },
    knobs: {
      trendingLimit: 20,
      // The floor that makes this a NEWS desk: fewer than three outlets whose
      // pages actually scraped, and it moves to the next story rather than
      // writing thin. Most cycles end here, and that is the feature.
      minSources: 3,
      pagesMax: 6,
      chunkChars: 24_000,
      maxChunksPerPage: 4,
      minContentChars: 400,
      // 0.62 suits embeddings; without an `embedder` the matcher falls back to
      // trigrams, which score lower — pass ~0.35 then.
      matchThreshold: 0.35,
      coveredThreshold: 0.35,
      parallelCount: 4,
      parallelMinScore: 0.3,
      echoCount: 4,
      analysisAttempts: 3,
    },
    log: (line: string) => process.stdout.write(`${line}\n`),
  });

  await desk.run();
}

main().catch((err: unknown) => {
  process.stderr.write(`news-desk failed: ${String(err)}\n`);
  process.exit(1);
});
