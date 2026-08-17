/**
 * run-news-desk.ts — operator-run: the full news desk on the local model.
 *
 *   FIRECRAWL_API_URL=… FIRECRAWL_API_KEY=… npx tsx examples/run-news-desk.ts
 *
 * Output: out/<slug>.md [DRAFT] + out/runs/<runId>/ provenance + covered.json.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createNewsDesk } from "../presets/news-desk";
import { createDatagod } from "../clients/datagod";
import { createOllamaLlm } from "../clients/ollama-llm";
import { createOllamaEmbedder } from "../clients/ollama-embedder";
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import type { OutletFeed } from "../sources/newswire";
import { dedupeTrending, fetchSiteStories, fetchTopicStories, fetchTrendingStories, GN_TOPICS, GN_US } from "../sources/google-news";
import type { SiteQuery, TrendingStory } from "../sources/google-news";
import type { BrandProfile, CoveredTopic, GeneratedPost, PublishResult, Sink } from "../ports";
import { FEEDS, ROSTER, SITE_TRENDING, pickOne } from "./desk-config";






const WRITER = pickOne(ROSTER);

const brand: BrandProfile = {
  name: "The Wire Desk",
  publication: "The Wire Desk (example.com)",
  beat: "world news and geopolitics",
  bylines: [WRITER.name],
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
  // log: the embed path is where the model-swap race surfaces (197 runs died
  // on it), so its retries must be visible in the run log, not silent.
  const embedder = createOllamaEmbedder({
    host: "http://localhost:11434",
    model: "embeddinggemma",
    log,
  });
  const search = createFirecrawlSearch({
    apiKey: process.env.FIRECRAWL_API_KEY,
    apiUrl: process.env.FIRECRAWL_API_URL,
  });

  const sink: Sink = {
    async publish(post: GeneratedPost): Promise<PublishResult> {
      const path = `out/${post.slug}.md`;
      await writeFile(path, post.markdown);
      // Meta sidecar: the loop publishes every new md with the title/byline
      // recorded here (the byline is the randomly drawn columnist — the loop
      // must not guess from filenames). `parallel` feeds the next runs'
      // recentParallels window.
      await writeFile(
        `out/${post.slug}.meta.json`,
        JSON.stringify(
          {
            title: post.title,
            byline: post.byline ?? "",
            tags: post.tags ?? [],
            section: post.section ?? "",
            description: post.description ?? "",
            imageUrl: post.imageUrl ?? "",
            imageCredit: post.imageCredit ?? "",
            imageSource: post.imageSource ?? "",
            parallel: typeof post.telemetry?.parallel === "string" ? post.telemetry.parallel : "",
            breaking: post.breaking === true,
          },
          null,
          2,
        ),
      );
      // Citations go in their own sidecar because publish-article.mjs already
      // takes `--sources file.json`, and because they belong in the `sources`
      // FIELD: the site renders them for readers, for crawlers that never run
      // JS, and as schema.org citation, and prose reaches only the first.
      if (post.sources !== undefined && post.sources.length > 0) {
        await writeFile(`out/${post.slug}.sources.json`, JSON.stringify(post.sources, null, 2));
      }
      process.stdout.write(`Published "${post.title}" → ${path} [DRAFT]\n`);
      let ledger: { title: string; slug: string; date: string }[] = [];
      try {
        ledger = JSON.parse(await readFile("out/covered.json", "utf8"));
      } catch {
        // first run
      }
      const gnHeadline = typeof post.telemetry?.topic === "string" ? post.telemetry.topic : post.title;
      // Ledger keyed to the GN headline — next-run dedup probes with raw GN
      // headlines, not the runTitle-rewritten one (final-review finding).
      ledger.push({ title: gnHeadline, slug: post.slug, date: new Date().toISOString() });
      await writeFile("out/covered.json", JSON.stringify(ledger, null, 2));
      return { url: path, status: "DRAFT" };
    },
  };

  // Trending supply (2026-07-24): the top-stories list alone starved cycles —
  // after the covered ledger and source floors, runs regularly exhausted. Six
  // GN topic feeds (WORLD…HEALTH) append as the tail: top stories keep
  // priority, round-robin topics fill it, near-identical headlines collapse
  // first-wins at trigram SUPPLY_DEDUPE.
  // ── Velocity tripwire ────────────────────────────────────────────────────
  // Google News publishes a RANKING, never a rate of climb, so "breaking" has
  // to be derived across runs: a story counts only if it is near the top of
  // the top-stories feed AND the desk has never seen it before. New + already
  // near the top is the shape of a story climbing fast; a story that has sat
  // in the ledger for hours is merely big.
  //
  // The first run has no ledger, so every headline is "new" and everything
  // would be breaking — hence the has-ledger guard. One per run, maximum: a
  // paper where two stories in every cycle are BREAKING has spent the word.
  const BREAKING_TOP_RANK = 5;
  // NOT out/trending-seen.json — that path belongs to examples/poll-trending.ts,
  // which stores a string[]. This ledger is a headline->first-seen map, and
  // writing an object there made the poller's `[...seen, ...fresh]` throw
  // "object is not iterable" every minute, wedging the newsroom for ~10
  // minutes on 2026-08-13 until the collision was spotted.
  const BREAKING_LEDGER = "out/breaking-seen.json";

  async function markBreaking(top: readonly TrendingStory[]): Promise<TrendingStory[]> {
    let seen: Record<string, string> = {};
    let hadLedger = true;
    try {
      seen = JSON.parse(await readFile(BREAKING_LEDGER, "utf8")) as Record<string, string>;
    } catch {
      hadLedger = false; // first run on this machine
    }
    const now = new Date().toISOString();
    let flagged = false;
    const out = top.map((story): TrendingStory => {
      const first = seen[story.headline];
      const isNew = first === undefined;
      if (isNew) seen[story.headline] = now;
      if (!hadLedger || flagged || !isNew || story.rank > BREAKING_TOP_RANK) return story;
      flagged = true;
      log(`news-desk: BREAKING — "${story.headline}" entered at rank ${story.rank}`);
      return { ...story, breaking: true };
    });
    // Keep the ledger from growing without bound: the tripwire only ever asks
    // "have I seen this before", and a day is far longer than a news cycle.
    const cutoff = Date.now() - 24 * 3600_000;
    const pruned = Object.fromEntries(
      Object.entries(seen).filter(([, at]) => new Date(at).getTime() >= cutoff),
    );
    try {
      await writeFile(BREAKING_LEDGER, JSON.stringify(pruned, null, 2));
    } catch (err: unknown) {
      // Best-effort, exactly like the covered ledger: a tripwire that cannot
      // write must not take down the run that would have published.
      log(`news-desk: could not write ${BREAKING_LEDGER} (continuing): ${String(err)}`);
    }
    return out;
  }

  const TRENDING_LIMIT = 20;
  const TOPIC_TAIL_LIMIT = 30;
  // Site tail (2026-08-10): ~2 per paper after the round-robin — enough to
  // surface each paper's top stories without drowning the US supply.
  const SITE_TAIL_LIMIT = 20;
  const SUPPLY_DEDUPE = 0.55;

  // Historical parallels used by the last dozen columns — the desk skips
  // these candidates outright so the paper doesn't reach for the same rhyme
  // week after week. Drawn from the meta sidecars the sink writes above.
  const RECENT_PARALLEL_WINDOW = 12;
  let recentParallels: string[] = [];
  try {
    const ledger: { slug: string }[] = JSON.parse(await readFile("out/covered.json", "utf8"));
    const metas = await Promise.all(
      ledger.slice(-RECENT_PARALLEL_WINDOW).map(async (c): Promise<{ parallel?: string }> => {
        try {
          return JSON.parse(await readFile(`out/${c.slug}.meta.json`, "utf8")) as { parallel?: string };
        } catch {
          return {}; // pre-sidecar article
        }
      }),
    );
    recentParallels = metas.map((m) => m.parallel ?? "").filter((p) => p !== "");
  } catch {
    // first run — no ledger yet
  }

  const desk = createNewsDesk({
    llm,
    search,
    embedder,
    feeds: FEEDS,
    persona: WRITER,
    // One take per story (operator, 2026-07-24): the drawn columnist's fused
    // column IS the article, under the source headline, capped at 600 words.
    authorVersions: { wordCap: 1100 }, // the MAX ceiling; per-story cap scales with evidence (evidenceWordCap)
    recentParallels,
    brand,
    sink,
    // Primary data (DataGod): active when the instance env is present.
    ...(process.env.DATAGOD_URL !== undefined && process.env.DATAGOD_API_KEY !== undefined
      ? { datagod: createDatagod({ apiUrl: process.env.DATAGOD_URL, apiKey: process.env.DATAGOD_API_KEY }) }
      : {}),
    // Lead-photo fallback: google images via the keyed SearXNG proxy.
    ...(process.env.IMAGE_SEARCH_URL !== undefined && process.env.IMAGE_SEARCH_KEY !== undefined
      ? { imageSearch: { url: process.env.IMAGE_SEARCH_URL, apiKey: process.env.IMAGE_SEARCH_KEY } }
      : {}),
    trendingImpl: async (): Promise<TrendingStory[]> => {
      // Only the top-stories feed carries a meaningful rank, so the tripwire
      // reads that one; the topic and site tails are supply, not signal.
      const top = await markBreaking(
        await fetchTrendingStories({ edition: GN_US, limit: TRENDING_LIMIT }),
      );
      const topics = await fetchTopicStories({
        edition: GN_US, topics: GN_TOPICS, limit: TOPIC_TAIL_LIMIT, dedupeThreshold: SUPPLY_DEDUPE, log,
      });
      // Third tail: per-paper site: feeds. Supply dedupe is trigram, so a
      // story trending in two LANGUAGES survives as two candidates — the
      // embedding-based covered ledger catches the translated duplicate on
      // the next cycle, and one cycle publishes one story, so no double-write.
      const sites = await fetchSiteStories({
        sites: SITE_TRENDING, limit: SITE_TAIL_LIMIT, dedupeThreshold: SUPPLY_DEDUPE, log,
      });
      return dedupeTrending([...top, ...topics, ...sites], SUPPLY_DEDUPE);
    },
    knobs: {
      trendingLimit: TRENDING_LIMIT, minSources: 3, pagesMax: 6,
      chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400,
      matchThreshold: 0.62, coveredThreshold: 0.55, // 0.62→0.55 2026-07-21: three same-arc articles in four — clustering trigger hit,
      // minScore 0.5 (operator, 2026-07-26): a parallel must genuinely fit or the
      // column takes the honest no-parallel path — no more Tiananmen-for-a-car-attack.
      parallelCount: 4, parallelMinScore: 0.5, analysisAttempts: 3,
    },
    // A covered story that is STILL trending is a developing story. The desk
    // used to drop it (573 of 1,929 runs ended with nothing for this reason);
    // now it lands in a queue that scripts/append-update.mjs drains, the same
    // out/-sidecar-then-publish shape everything else here uses. Writing the
    // update is deliberately NOT done inline: the desk's hot path publishes
    // the paper every 25 minutes and must not grow a second failure mode.
    onCovered: async (dev): Promise<void> => {
      let queue: unknown[] = [];
      try {
        queue = JSON.parse(await readFile("out/developing.json", "utf8")) as unknown[];
      } catch {
        // first developing story
      }
      queue.push({ ...dev, at: new Date().toISOString() });
      // Bounded: the drain script removes what it files, and a queue that grew
      // without bound would replay week-old clusters after any outage.
      await writeFile("out/developing.json", JSON.stringify(queue.slice(-100), null, 2));
    },
    coveredTopics: async (): Promise<CoveredTopic[]> => {
      try {
        return JSON.parse(await readFile("out/covered.json", "utf8"));
      } catch {
        return [];
      }
    },
    usedImages: async (): Promise<readonly string[]> => {
      // Every published article's lead-image URL, from the meta sidecars — so a
      // new story never reuses a photo already on the site.
      try {
        const files = (await readdir("out")).filter((f) => f.endsWith(".meta.json"));
        const urls = await Promise.all(
          files.map(async (f): Promise<string> => {
            try {
              return (JSON.parse(await readFile(`out/${f}`, "utf8")) as { imageUrl?: string }).imageUrl ?? "";
            } catch {
              return "";
            }
          }),
        );
        return urls.filter((u) => u !== "");
      } catch {
        return [];
      }
    },
    log,
    recordArtifact,
  });

  const post = await desk.run();
  process.stdout.write(`Run complete: "${post.title}" by ${post.byline ?? "?"} — provenance: ${runDir}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`run-news-desk failed: ${String(err)}\n`);
  process.exit(1);
});
