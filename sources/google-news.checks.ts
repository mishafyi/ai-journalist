import {
  dedupeTrending,
  fetchTopicStories,
  googleNewsTopicUrl,
  googleNewsTopUrl,
  GN_US,
  parseTopicStories,
  parseTrending,
} from "./google-news";

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

  // ── Topic feeds (tail supply) ─────────────────────────────────────────────

  ok("topic URL targets the section/topic path with hl/gl/ceid",
    googleNewsTopicUrl("WORLD", GN_US) ===
      "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US%3Aen",
    googleNewsTopicUrl("WORLD", GN_US));

  // Fixture pair-similarities verified against primitives.trigramSimilarity:
  // the two famine headlines score 0.81 (dupe), every cross pair ≤0.12.
  const WORLD_XML = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>World - Latest - Google News</title>
<item><title>Ceasefire talks resume in Cairo - Reuters</title>
<link>https://news.google.com/rss/articles/CBMiWWW?oc=5</link>
<source url="https://www.reuters.com">Reuters</source>
<description>&lt;a href="https://news.google.com/rss/articles/CBMiWWW?oc=5"&gt;Ceasefire talks resume in Cairo&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Reuters&lt;/font&gt;</description></item>
<item><title>UN warns of famine risk in Sudan - BBC</title>
<link>https://news.google.com/rss/articles/CBMiXXX?oc=5</link>
<source url="https://www.bbc.com">BBC</source>
<description>&lt;ol&gt;&lt;li&gt;&lt;a href="https://news.google.com/rss/articles/CBMiXXX?oc=5"&gt;UN warns of famine risk in Sudan&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;BBC&lt;/font&gt;&lt;/li&gt;&lt;li&gt;&lt;a href="https://news.google.com/rss/articles/CBMiYYY?oc=5"&gt;Sudan famine warning issued by UN&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Al Jazeera&lt;/font&gt;&lt;/li&gt;&lt;/ol&gt;</description></item>
<item><title>Volcano erupts in Iceland - AP News</title>
<link>https://news.google.com/rss/articles/CBMiZZZ?oc=5</link>
<description>&lt;a href="https://news.google.com/rss/articles/CBMiZZZ?oc=5"&gt;Volcano erupts in Iceland&lt;/a&gt;</description></item>
</channel></rss>`;
  const BUSINESS_XML = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>Business - Latest - Google News</title>
<item><title>Dow closes above 50,000 - a new record</title>
<link>https://news.google.com/rss/articles/CBMiBBB?oc=5</link>
<source url="https://www.cnbc.com">CNBC</source></item>
<item><title>UN warns famine risk grows in Sudan - Al Jazeera</title>
<link>https://news.google.com/rss/articles/CBMiCCC?oc=5</link>
<source url="https://www.aljazeera.com">Al Jazeera</source>
<description>&lt;a href="https://news.google.com/rss/articles/CBMiCCC?oc=5"&gt;UN warns famine risk grows in Sudan&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Al Jazeera&lt;/font&gt;</description></item>
</channel></rss>`;

  const world = await parseTopicStories(WORLD_XML);
  ok("topic title strips ' - Outlet' when it matches the <source> tag",
    world[0].headline === "Ceasefire talks resume in Cairo" && world[0].leadOutlet === "Reuters",
    JSON.stringify({ h: world[0].headline, o: world[0].leadOutlet }));
  ok("topic item with a coverage cluster keeps every entry",
    world[1].coverage.length === 2 && world[1].coverage[1].outlet === "Al Jazeera",
    JSON.stringify(world[1].coverage));
  ok("no <source> tag → title kept whole, outlet empty",
    world[2].headline === "Volcano erupts in Iceland - AP News" && world[2].leadOutlet === "",
    JSON.stringify({ h: world[2].headline, o: world[2].leadOutlet }));

  const business = await parseTopicStories(BUSINESS_XML);
  ok("suffix that is NOT the <source> outlet is real headline text — kept",
    business[0].headline === "Dow closes above 50,000 - a new record" && business[0].leadOutlet === "CNBC",
    JSON.stringify({ h: business[0].headline, o: business[0].leadOutlet }));
  ok("no description → the item covers itself",
    business[0].coverage.length === 1 && business[0].coverage[0].outlet === "CNBC",
    JSON.stringify(business[0].coverage));

  const fakeFetch = (routes: Record<string, string>): typeof fetch =>
    (async (input: unknown): Promise<Response> => {
      const body = routes[String(input)];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

  const topicRoutes = {
    [googleNewsTopicUrl("WORLD", GN_US)]: WORLD_XML,
    [googleNewsTopicUrl("BUSINESS", GN_US)]: BUSINESS_XML,
  };
  const merged = await fetchTopicStories({
    edition: GN_US, topics: ["WORLD", "BUSINESS"], limit: 10, dedupeThreshold: 0.55,
    fetchImpl: fakeFetch(topicRoutes),
  });
  ok("round-robin interleave: WORLD[0], BUSINESS[0], WORLD[1], … re-ranked 1..n",
    merged.length === 4 &&
      merged[0].headline === "Ceasefire talks resume in Cairo" &&
      merged[1].headline === "Dow closes above 50,000 - a new record" &&
      merged[2].headline === "UN warns of famine risk in Sudan" &&
      merged[3].headline === "Volcano erupts in Iceland - AP News" &&
      merged.every((s, i) => s.rank === i + 1),
    JSON.stringify(merged.map((s) => `${s.rank}:${s.headline}`)));
  ok("cross-feed near-duplicate collapses to the FIRST occurrence (0.81 ≥ 0.55)",
    merged.every((s) => s.headline !== "UN warns famine risk grows in Sudan"),
    JSON.stringify(merged.map((s) => s.headline)));

  const logged: string[] = [];
  const partial = await fetchTopicStories({
    edition: GN_US, topics: ["WORLD", "BUSINESS"], limit: 10, dedupeThreshold: 0.55,
    fetchImpl: fakeFetch({ [googleNewsTopicUrl("WORLD", GN_US)]: WORLD_XML }),
    log: (line) => logged.push(line),
  });
  ok("a dead topic feed logs FAILED and never kills the others (newswire rule)",
    partial.length === 3 && logged.some((l) => l.includes("topic feed FAILED BUSINESS")),
    JSON.stringify({ n: partial.length, logged }));

  const prioritized = dedupeTrending(
    [
      { rank: 7, headline: "Senate passes the tariff bill", leadOutlet: "BBC", coverage: [] },
      { rank: 1, headline: "Tariff bill passes the Senate", leadOutlet: "CNN", coverage: [] },
    ],
    0.55,
  );
  ok("dedupeTrending keeps the earlier entry on a near-dupe (0.93) and re-ranks",
    prioritized.length === 1 && prioritized[0].leadOutlet === "BBC" && prioritized[0].rank === 1,
    JSON.stringify(prioritized));

  // Live smoke — one real topic feed must parse ≥5 items. SKIPs cleanly
  // offline (datagod-drift pattern) so the normal gate never needs the network.
  try {
    const res = await fetch(googleNewsTopicUrl("WORLD", GN_US), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const live = await parseTopicStories(await res.text());
    ok("live WORLD topic feed parses ≥5 items with non-empty headlines",
      live.length >= 5 && live.every((s) => s.headline !== ""),
      `got ${live.length} items`);
  } catch (err: unknown) {
    process.stdout.write(
      `SKIP google-news live topic smoke — feed unreachable (${String(err).slice(0, 80)}); this check needs the network\n`,
    );
  }

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
