/**
 * poll-trending.ts — the cheap tripwire in front of run-news-desk (operator,
 * 2026-07-25: "the algo gets notification as soon as new news published by
 * Google Trending News and starts writing").
 *
 * Fetches the same trending supply as the desk (top stories + topic tails),
 * diffs headlines against out/trending-seen.json, and answers via exit code:
 *
 *   exit 0 — new headlines appeared (printed, seen-file updated) → run the desk
 *   exit 3 — nothing new → poll again later
 *   exit 1 — fetch/parse failure (loud)
 *
 * Exact-string newness is deliberate: it only decides WHEN to wake the desk;
 * the desk itself re-checks everything with real similarity matching. The
 * seen-file is capped so it never grows without bound.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dedupeTrending, fetchTopicStories, fetchTrendingStories, GN_TOPICS, GN_US } from "../sources/google-news";

const SEEN_PATH = "out/trending-seen.json";
const SEEN_CAP = 800;

async function main(): Promise<void> {
  const top = await fetchTrendingStories({ edition: GN_US, limit: 20 });
  const topics = await fetchTopicStories({
    edition: GN_US,
    topics: GN_TOPICS,
    limit: 30,
    dedupeThreshold: 0.55,
    log: () => {},
  });
  const current = dedupeTrending([...top, ...topics], 0.55).map((s) => s.headline);

  let seen: string[] = [];
  try {
    seen = JSON.parse(await readFile(SEEN_PATH, "utf8")) as string[];
  } catch {
    // first run — everything is new
  }
  const seenSet = new Set(seen);
  const fresh = current.filter((h) => !seenSet.has(h));

  await mkdir("out", { recursive: true });
  await writeFile(SEEN_PATH, JSON.stringify([...seen, ...fresh].slice(-SEEN_CAP), null, 2));

  if (fresh.length === 0) {
    process.stdout.write("trending: nothing new\n");
    process.exitCode = 3;
    return;
  }
  process.stdout.write(`trending: ${fresh.length} new headline(s)\n`);
  for (const h of fresh) process.stdout.write(`  + ${h}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`poll-trending failed: ${String(err)}\n`);
  process.exit(1);
});
