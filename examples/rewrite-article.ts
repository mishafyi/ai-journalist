/**
 * rewrite-article.ts — re-report ONE already-published story from clean sources.
 *
 * The provenance purge (2026-08-16) stripped citations from impersonators,
 * scrapers and aggregators, which left 145 news stories holding fewer than the
 * desk's own three-source floor. Their prose was written from evidence
 * extracted off those pages, so it cannot simply be re-cited — it has to be
 * re-reported. This runs the ordinary desk on a single known headline:
 *
 *   npx tsx examples/rewrite-article.ts \
 *     --headline "…" --slug "…" [--byline "Alma Cordero"]
 *
 * The pipeline is unchanged (Google-News coverage → index/site-restricted
 * resolution → scrape → evidence floors → verified parallel → column), so a
 * rewrite is held to exactly the standard a new story is. Two deliberate
 * differences:
 *
 *   - the SLUG is forced, so the rewrite lands on the existing URL rather than
 *     forking a second article at a new address;
 *   - the BYLINE is forced to whoever already signed it, because a column is
 *     an argument in one person's voice and the archive should not silently
 *     reassign it.
 *
 * Exit codes: 0 wrote out/<slug>.md, 3 could not reach the source floor (the
 * caller unpublishes rather than leave junk-built prose live), 1 real failure.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createNewsDesk } from "../presets/news-desk";
import { createOllamaLlm } from "../clients/ollama-llm";
import { createOllamaEmbedder } from "../clients/ollama-embedder";
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import { createDatagod } from "../clients/datagod";
import { FEEDS, ROSTER } from "./desk-config";
import type { TrendingStory } from "../sources/google-news";
import type { BrandProfile, GeneratedPost, PublishResult, Sink } from "../ports";

const arg = (flag: string, fallback = ""): string => {
  const i = process.argv.indexOf(flag);
  return i === -1 || process.argv[i + 1] === undefined ? fallback : process.argv[i + 1];
};
const headline = arg("--headline");
const slug = arg("--slug");
const wantedByline = arg("--byline");
if (headline === "" || slug === "") {
  process.stderr.write('usage: rewrite-article.ts --headline "…" --slug "…" [--byline "…"]\n');
  process.exit(2);
}

const writer = ROSTER.find((c) => c.name === wantedByline) ?? ROSTER[0];
if (wantedByline !== "" && writer.name !== wantedByline) {
  process.stdout.write(`note: "${wantedByline}" is not on the roster — writing as ${writer.name}\n`);
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<void> {
  const llm = createOllamaLlm({
    baseUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.OLLAMA_MODEL ?? "gemma4:e4b",
  });
  const embedder = createOllamaEmbedder({
    host: process.env.OLLAMA_URL ?? "http://localhost:11434",
    model: "embeddinggemma",
    log,
  });
  const search = createFirecrawlSearch({
    apiKey: process.env.FIRECRAWL_API_KEY,
    apiUrl: process.env.FIRECRAWL_API_URL,
  });

  const brand: BrandProfile = {
    name: "The Wire Desk",
    publication: "The Wire Desk (example.com)",
    beat: "world news and geopolitics",
    bylines: [writer.name],
  };

  let wrote: GeneratedPost | null = null;
  const sink: Sink = {
    async publish(post: GeneratedPost): Promise<PublishResult> {
      wrote = post;
      await mkdir("out", { recursive: true });
      // Forced slug: the rewrite must land on the story's existing URL.
      await writeFile(`out/${slug}.md`, post.markdown);
      await writeFile(
        `out/${slug}.meta.json`,
        JSON.stringify(
          {
            title: post.title,
            byline: post.byline ?? writer.name,
            tags: post.tags ?? [],
            section: post.section ?? "",
            description: post.description ?? "",
            imageUrl: post.imageUrl ?? "",
            imageCredit: post.imageCredit ?? "",
            imageSource: post.imageSource ?? "",
            rewrittenAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      if (post.sources !== undefined && post.sources.length > 0) {
        await writeFile(`out/${slug}.sources.json`, JSON.stringify(post.sources, null, 2));
      }
      return { url: `out/${slug}.md`, status: "DRAFT" };
    },
  };

  const desk = createNewsDesk({
    llm,
    search,
    embedder,
    feeds: FEEDS,
    persona: writer,
    authorVersions: { wordCap: 1100 },
    brand,
    sink,
    ...(process.env.DATAGOD_URL !== undefined && process.env.DATAGOD_API_KEY !== undefined
      ? { datagod: createDatagod({ apiUrl: process.env.DATAGOD_URL, apiKey: process.env.DATAGOD_API_KEY }) }
      : {}),
    ...(process.env.IMAGE_SEARCH_URL !== undefined && process.env.IMAGE_SEARCH_KEY !== undefined
      ? { imageSearch: { url: process.env.IMAGE_SEARCH_URL, apiKey: process.env.IMAGE_SEARCH_KEY } }
      : {}),
    // One story, the one we are repairing. Coverage lookup is not time-boxed
    // here: these stories are days old, and "when:7d" would find nothing.
    trendingImpl: async (): Promise<TrendingStory[]> => [
      { rank: 1, headline, leadOutlet: "", coverage: [] },
    ],
    // The covered ledger would skip this story by definition — it IS covered.
    coveredTopics: async () => [],
    knobs: {
      trendingLimit: 1,
      minSources: 3,
      pagesMax: 6,
      chunkChars: 24_000,
      maxChunksPerPage: 4,
      minContentChars: 400,
      matchThreshold: 0.62,
      coveredThreshold: 0.55,
      parallelCount: 4,
      parallelMinScore: 0.5,
      analysisAttempts: 3,
    },
    log,
  });

  try {
    await desk.run();
  } catch (err: unknown) {
    const msg = String(err);
    // The desk's own floors, reported as "could not re-source", not a crash.
    if (/resolved ≥|no trending story|kept \d+\//.test(msg)) {
      process.stderr.write(`unsourceable: ${msg}\n`);
      process.exit(3);
    }
    throw err;
  }
  if (wrote === null) {
    process.stderr.write("unsourceable: the desk produced nothing\n");
    process.exit(3);
  }
  process.stdout.write(`rewrote ${slug} as ${writer.name}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`rewrite-article failed: ${String(err)}\n`);
  process.exit(1);
});
