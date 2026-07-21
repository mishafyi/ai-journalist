import { parseTrending, googleNewsTopUrl, GN_US } from "./google-news";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>Top stories - Google News</title>
<item><title>Tariff bill passes Senate - BBC</title>
<link>https://news.google.com/rss/articles/CBMiAAA?oc=5</link>
<pubDate>Tue, 21 Jul 2026 00:34:47 GMT</pubDate>
<description>&lt;ol&gt;&lt;li&gt;&lt;a href="https://news.google.com/rss/articles/CBMiAAA?oc=5"&gt;Tariff bill passes Senate&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;BBC&lt;/font&gt;&lt;/li&gt;&lt;li&gt;&lt;a href="https://news.google.com/rss/articles/CBMiBBB?oc=5"&gt;Senate approves sweeping tariffs&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;CNN&lt;/font&gt;&lt;/li&gt;&lt;/ol&gt;</description></item>
<item><title>Storm hits coast - AP News</title>
<link>https://news.google.com/rss/articles/CBMiCCC?oc=5</link>
<description>&lt;a href="https://news.google.com/rss/articles/CBMiCCC?oc=5"&gt;Storm hits coast&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;AP News&lt;/font&gt;</description></item>
</channel></rss>`;

  const stories = await parseTrending(FIXTURE);
  ok("two stories, rank preserved in feed order",
    stories.length === 2 && stories[0].rank === 1 && stories[1].rank === 2, JSON.stringify(stories.map((s) => s.rank)));
  ok("lead headline strips the ' - Outlet' suffix; leadOutlet captured",
    stories[0].headline === "Tariff bill passes Senate" && stories[0].leadOutlet === "BBC",
    JSON.stringify({ h: stories[0].headline, o: stories[0].leadOutlet }));
  ok("coverage list parsed with outlet names",
    stories[0].coverage.length === 2 && stories[0].coverage[1].headline === "Senate approves sweeping tariffs" &&
      stories[0].coverage[1].outlet === "CNN",
    JSON.stringify(stories[0].coverage));
  ok("single-link description (no <ol>) still yields one coverage entry",
    stories[1].coverage.length === 1 && stories[1].coverage[0].outlet === "AP News",
    JSON.stringify(stories[1].coverage));
  ok("edition URL carries hl/gl/ceid",
    googleNewsTopUrl(GN_US) === "https://news.google.com/rss?hl=en-US&gl=US&ceid=US%3Aen",
    googleNewsTopUrl(GN_US));

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("google-news checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`google-news.checks failed: ${String(err)}\n`);
  process.exit(1);
});
