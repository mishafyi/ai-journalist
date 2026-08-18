/**
 * Behavioral checks for write-article.ts — the one-call entry.
 *
 * Run directly (deliberately *.checks.ts, not *.test.ts, so vitest's CI glob
 * never picks it up):
 *
 *   npx tsx write-article.checks.ts
 *
 * Covers the two things this module actually decides: which `Source` your input
 * resolves to, and which `BrandProfile` fields get filled in. The pipeline
 * itself is exercised by examples/basic.ts.
 *
 * Prints one PASS/FAIL line per case; exits 1 on any failure.
 */
import {
  completeBrand,
  looksLikeFeed,
  resolveSource,
  type ArticleInput,
} from "./write-article";
import type { DiscoverySignal, SignalItem } from "./ports";

let failures = 0;
let passes = 0;

function ok(name: string, cond: boolean, detail: string): void {
  if (cond) {
    passes += 1;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`FAIL ${name} — ${detail}\n`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}, got ${a}`);
}

function throws(name: string, fn: () => unknown, match: string): void {
  try {
    fn();
    ok(name, false, "expected a throw, got none");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(name, msg.includes(match), `message did not contain "${match}": ${msg}`);
  }
}

const item: SignalItem = {
  title: "Acme raises $40M",
  summary: "Series B for direct-air capture.",
  entities: ["Acme"],
};

// ── from: array of items ────────────────────────────────────────────────────
{
  const source = resolveSource([item]);
  ok("array → Source", typeof source.gatherSignal === "function", "no gatherSignal");
  void source.gatherSignal().then((signal: DiscoverySignal) => {
    eq("array → signal carries the items", signal.items.length, 1);
  });
}

// ── from: a DiscoverySignal ─────────────────────────────────────────────────
{
  const source = resolveSource({ items: [item], framing: "climate tech" });
  void source.gatherSignal().then((signal: DiscoverySignal) => {
    eq("signal → framing preserved", signal.framing, "climate tech");
  });
}

// ── from: an existing Source passes straight through ────────────────────────
{
  const custom = { gatherSignal: async (): Promise<DiscoverySignal> => ({ items: [item] }) };
  ok("Source → returned as-is", resolveSource(custom) === custom, "wrapped instead of passed through");
}

// ── empty input must fail loud, never yield an empty signal ─────────────────
throws("empty array throws", () => resolveSource([]), "empty array");
throws(
  "signal with no items throws",
  () => resolveSource({ items: [] }),
  "`from.items` is empty",
);
throws(
  "a non-input type throws naming the type",
  () => resolveSource(42 as unknown as ArticleInput),
  "received number",
);

// ── feed detection: which URLs parse as RSS rather than JSON ────────────────
for (const url of [
  "https://example.com/feed.xml",
  "https://example.com/index.rss",
  "https://example.com/blog/atom",
  "https://example.com/feed",
  "https://example.com/rss/",
]) {
  ok(`feed URL: ${url}`, looksLikeFeed(url), "not detected as a feed");
}
for (const url of [
  "https://example.com/api/signal",
  "https://example.com/signal.json",
  "https://feeds-r-us.example.com/api/v1/items",
]) {
  ok(`json URL: ${url}`, !looksLikeFeed(url), "wrongly detected as a feed");
}

// ── brand completion: the two derived fields ────────────────────────────────
{
  const brand = completeBrand({ name: "My Outlet", beat: "climate tech" });
  eq("brand.publication defaults to name", brand.publication, "My Outlet");
  eq("brand.bylines defaults to a staff byline", brand.bylines, ["My Outlet Staff"]);
  eq("brand.beat preserved", brand.beat, "climate tech");
}
{
  const brand = completeBrand({
    name: "My Outlet",
    beat: "climate tech",
    publication: "My Outlet (myoutlet.com)",
    bylines: ["A. Writer"],
  });
  eq("explicit publication wins", brand.publication, "My Outlet (myoutlet.com)");
  eq("explicit bylines win", brand.bylines, ["A. Writer"]);
}

process.on("exit", () => {
  process.stdout.write(`\n${passes} passed, ${failures} failed\n`);
  if (failures > 0) process.exitCode = 1;
});
