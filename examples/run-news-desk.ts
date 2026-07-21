/**
 * run-news-desk.ts — operator-run: the full news desk on the local model.
 *
 *   FIRECRAWL_API_URL=… FIRECRAWL_API_KEY=… npx tsx examples/run-news-desk.ts
 *
 * Output: out/<slug>.md [DRAFT] + out/runs/<runId>/ provenance + covered.json.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createNewsDesk, PERSONAS } from "../presets/news-desk";
import { createOllamaLlm } from "../clients/ollama-llm";
import { createOllamaEmbedder } from "../clients/ollama-embedder";
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import type { OutletFeed } from "../sources/newswire";
import type { BrandProfile, CoveredTopic, GeneratedPost, PublishResult, Sink } from "../ports";

/** PASSing set from examples/probe-feeds.ts — edit after each probe run. */
const FEEDS: OutletFeed[] = [
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", outlet: "BBC", region: "EU" },
  { url: "https://www.theguardian.com/world/rss", outlet: "The Guardian", region: "EU" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", outlet: "Al Jazeera", region: "MENA" },
  { url: "https://feeds.npr.org/1001/rss.xml", outlet: "NPR", region: "US" },
  { url: "https://rss.politico.com/politics-news.xml", outlet: "Politico", region: "US" },
  { url: "https://thehill.com/homenews/feed/", outlet: "The Hill", region: "US" },
];

const brand: BrandProfile = {
  name: "The Wire Desk",
  publication: "The Wire Desk (example.com)",
  beat: "world news and geopolitics",
  bylines: [PERSONAS.historian.name],
};

async function main(): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = `out/runs/${runId}`;
  await mkdir(runDir, { recursive: true });
  let artifactN = 0;
  const recordArtifact = (label: string, content: string): void => {
    artifactN += 1;
    const file = `${runDir}/${String(artifactN).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.txt`;
    void writeFile(file, content);
  };
  // createNewsDesk's fact-check-audit try/catch is best-effort and log-only —
  // on failure it never calls recordArtifact, so a dead audit would otherwise
  // be invisible under out/runs/. Mirror that one log line into an artifact
  // here so silent audit death still shows up in provenance.
  const log = (l: string): void => {
    process.stdout.write(l + "\n");
    if (l.includes("fact-check audit failed")) recordArtifact("fact-check-audit FAILED", l);
  };

  const llm = createOllamaLlm({
    baseUrl: "http://localhost:11434",
    model: "gemma4:e4b",
    options: { numCtx: 32768, keepAlive: "30m" },
  });
  const embedder = createOllamaEmbedder({ host: "http://localhost:11434", model: "embeddinggemma" });
  const search = createFirecrawlSearch({
    apiKey: process.env.FIRECRAWL_API_KEY,
    apiUrl: process.env.FIRECRAWL_API_URL,
  });

  const sink: Sink = {
    async publish(post: GeneratedPost): Promise<PublishResult> {
      const path = `out/${post.slug}.md`;
      await writeFile(path, post.markdown);
      let ledger: { title: string; slug: string; date: string }[] = [];
      try {
        ledger = JSON.parse(await readFile("out/covered.json", "utf8"));
      } catch {
        // first run
      }
      ledger.push({ title: post.title, slug: post.slug, date: new Date().toISOString() });
      await writeFile("out/covered.json", JSON.stringify(ledger, null, 2));
      return { url: path, status: "DRAFT" };
    },
  };

  const desk = createNewsDesk({
    llm,
    search,
    embedder,
    feeds: FEEDS,
    persona: PERSONAS.historian,
    brand,
    sink,
    knobs: {
      trendingLimit: 20, minSources: 3, pagesMax: 6,
      chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400,
      matchThreshold: 0.62, coveredThreshold: 0.62,
      parallelCount: 4, parallelMinScore: 0.3, analysisAttempts: 3,
    },
    coveredTopics: async (): Promise<CoveredTopic[]> => {
      try {
        return JSON.parse(await readFile("out/covered.json", "utf8"));
      } catch {
        return [];
      }
    },
    log,
    recordArtifact,
  });

  const post = await desk.run();
  process.stdout.write(`Published "${post.title}" → out/${post.slug}.md [DRAFT] (provenance: ${runDir})\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`run-news-desk failed: ${String(err)}\n`);
  process.exit(1);
});
