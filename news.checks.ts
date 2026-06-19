/**
 * Checks for news.ts — run: npx tsx news.checks.ts
 * Mirrors text.checks.ts: eq(name, actual, expected) + a pass/fail summary.
 */
import { isBlockedHost, DEFAULT_BLOCKED_HOSTS, parseRssTitles } from "./news";

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}\n`);
  }
}

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Google News</title>
  <item>
    <title>OpenAI is hiring robotics engineers - Tech Funding News</title>
    <link>https://news.google.com/rss/articles/ABC123?oc=5</link>
    <pubDate>Mon, 01 Jun 2026 07:00:00 GMT</pubDate>
    <source url="https://techfundingnews.com">Tech Funding News</source>
  </item>
  <item>
    <title>Anduril posts 200 defense roles - Defense Daily</title>
    <link>https://news.google.com/rss/articles/DEF456?oc=5</link>
  </item>
</channel></rss>`;

async function main(): Promise<void> {
  // isBlockedHost — paywalled majors + .mil block; wire/PR don't. The list is a
  // parameter now (engine reads no env); DEFAULT_BLOCKED_HOSTS is the stable default.
  const B = DEFAULT_BLOCKED_HOSTS;
  eq("blocked: wsj.com", isBlockedHost("wsj.com", B), true);
  eq("blocked: www.nytimes.com", isBlockedHost("www.nytimes.com", B), true);
  eq(
    "blocked: sub.bloomberg.com",
    isBlockedHost("markets.bloomberg.com", B),
    true,
  );
  eq("blocked: army.mil", isBlockedHost("army.mil", B), true);
  eq("not blocked: prnewswire.com", isBlockedHost("prnewswire.com", B), false);
  eq(
    "not blocked: businesswire.com",
    isBlockedHost("businesswire.com", B),
    false,
  );
  eq("not blocked: techcrunch.com", isBlockedHost("techcrunch.com", B), false);

  // parseRssTitles — extracts title + link per item, drops link-less items.
  const items = await parseRssTitles(FIXTURE);
  eq("rss: item count", items.length, 2);
  eq(
    "rss: first title",
    items[0]?.title,
    "OpenAI is hiring robotics engineers - Tech Funding News",
  );
  eq(
    "rss: first link",
    items[0]?.link,
    "https://news.google.com/rss/articles/ABC123?oc=5",
  );
  eq("rss: first date", items[0]?.date, "Mon, 01 Jun 2026 07:00:00 GMT");
  eq(
    "rss: first source (from <source>)",
    items[0]?.source,
    "Tech Funding News",
  );
  eq("rss: second title present", (items[1]?.title ?? "").length > 0, true);
  eq("rss: missing source → empty string", items[1]?.source, "");

  process.stdout.write(
    failed === 0
      ? `\nALL ${passed} checks passed\n`
      : `\n${failed} FAILED, ${passed} passed\n`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
