/**
 * Build a corpus of real, editor-crafted headlines from top frontier-tech
 * publications — raw material + style exemplars for the generator's Title pass
 * (the headline pass's `runTitle`). Writes headlines.json next to this script.
 *
 * Two source kinds:
 *   - Publication RSS/Atom feeds — headlines written by professional desk
 *     editors (SpaceNews, IEEE Spectrum, TechCrunch, The Verge, ...).
 *   - Google News RSS across broad space/AI/robotics/defense/careers seeds —
 *     wide coverage of real publisher headlines (the " - Source" suffix stripped).
 * Deduped, length-filtered, domain-tagged. Commit the JSON (a static asset);
 * re-run occasionally to refresh.
 *
 * Run (no API keys needed):
 *   npx tsx build-headline-corpus.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface Headline {
  title: string;
  source: string;
  domain: string;
}

// Publication feeds — editor-crafted headlines. domain is the dominant beat.
const FEEDS: { url: string; source: string; domain: string }[] = [
  { url: "https://spacenews.com/feed/", source: "SpaceNews", domain: "space" },
  {
    url: "https://spectrum.ieee.org/feeds/feed.rss",
    source: "IEEE Spectrum",
    domain: "robotics",
  },
  { url: "https://techcrunch.com/feed/", source: "TechCrunch", domain: "ai" },
  {
    url: "https://www.theverge.com/rss/index.xml",
    source: "The Verge",
    domain: "ai",
  },
  {
    url: "https://feeds.arstechnica.com/arstechnica/index",
    source: "Ars Technica",
    domain: "general",
  },
  {
    url: "https://www.technologyreview.com/feed/",
    source: "MIT Tech Review",
    domain: "ai",
  },
  { url: "https://venturebeat.com/feed/", source: "VentureBeat", domain: "ai" },
  {
    url: "https://www.theregister.com/headlines.atom",
    source: "The Register",
    domain: "general",
  },
  {
    url: "https://breakingdefense.com/feed/",
    source: "Breaking Defense",
    domain: "defense",
  },
  { url: "https://www.wired.com/feed/rss", source: "Wired", domain: "general" },
];

// Google News RSS seeds — broad real-headline coverage per beat.
const NEWS_SEEDS: { q: string; domain: string }[] = [
  { q: "space industry", domain: "space" },
  { q: "rocket launch startup", domain: "space" },
  { q: "satellite company funding", domain: "space" },
  { q: "NASA contract", domain: "space" },
  { q: "artificial intelligence startup", domain: "ai" },
  { q: "AI chips data center", domain: "ai" },
  { q: "OpenAI Anthropic", domain: "ai" },
  { q: "machine learning model", domain: "ai" },
  { q: "humanoid robot", domain: "robotics" },
  { q: "robotics company", domain: "robotics" },
  { q: "autonomous vehicles", domain: "robotics" },
  { q: "warehouse automation robots", domain: "robotics" },
  { q: "defense technology startup", domain: "defense" },
  { q: "military drones", domain: "defense" },
  { q: "semiconductor manufacturing", domain: "ai" },
  { q: "quantum computing", domain: "ai" },
  { q: "tech layoffs", domain: "general" },
  { q: "startup funding round", domain: "general" },
  { q: "engineer salary hiring", domain: "general" },
  { q: "venture capital deep tech", domain: "general" },
];

/** Extract <title> text from every RSS <item> and Atom <entry> in a feed. */
function parseFeedTitles(xml: string): string[] {
  const blocks =
    xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/g) ?? [];
  const out: string[] = [];
  for (const b of blocks) {
    const m = b.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    if (!m) continue;
    const codePoint = (n: number): string =>
      n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    const t = m[1]
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (t) out.push(t);
  }
  return out;
}

/** Keep crafted news headlines; drop fragments, all-caps, and promo junk. */
function isGood(t: string): boolean {
  if (t.length < 25 || t.length > 140) return false;
  if (/^[^a-z]*$/.test(t)) return false; // no lowercase = ALL CAPS / junk
  if (
    /sponsored|advertisement|% off|coupon|deal of the|best deals|[™®]/i.test(t)
  )
    return false;
  if (!/\s/.test(t)) return false; // single token
  return true;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (headline corpus builder)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const seen = new Set<string>();
  const corpus: Headline[] = [];
  const add = (raw: string, source: string, domain: string): void => {
    // Google News titles end in " - Publisher"; publication feeds don't.
    const title =
      source === "Google News" ? raw.replace(/\s+-\s+[^-]+$/, "").trim() : raw;
    const key = title.toLowerCase();
    if (isGood(title) && !seen.has(key)) {
      seen.add(key);
      corpus.push({ title, source, domain });
    }
  };

  process.stdout.write("Publication feeds:\n");
  for (const f of FEEDS) {
    try {
      const titles = parseFeedTitles(await fetchText(f.url));
      titles.forEach((t) => {
        add(t, f.source, f.domain);
      });
      process.stdout.write(`  ${f.source}: ${titles.length} titles\n`);
    } catch (e) {
      process.stdout.write(
        `  ${f.source}: skipped (${e instanceof Error ? e.message : e})\n`,
      );
    }
  }

  process.stdout.write("Google News seeds:\n");
  for (const s of NEWS_SEEDS) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
        s.q,
      )}&hl=en-US&gl=US&ceid=US:en`;
      const titles = parseFeedTitles(await fetchText(url));
      titles.forEach((t) => {
        add(t, "Google News", s.domain);
      });
      process.stdout.write(`  "${s.q}": ${titles.length} titles\n`);
    } catch (e) {
      process.stdout.write(
        `  "${s.q}": skipped (${e instanceof Error ? e.message : e})\n`,
      );
    }
  }

  const outPath = join(import.meta.dirname, "headlines.json");
  writeFileSync(outPath, JSON.stringify(corpus));
  const byDomain = corpus.reduce<Record<string, number>>((a, h) => {
    a[h.domain] = (a[h.domain] ?? 0) + 1;
    return a;
  }, {});
  process.stdout.write(
    `\n${corpus.length} unique headlines → ${outPath}\n  by domain: ${JSON.stringify(
      byDomain,
    )}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`ERROR: ${e instanceof Error ? e.message : e}\n`);
  process.exitCode = 1;
});
