import { DATA_PLAYS, PERSONAS, createNewsDesk, gatherPrimaryData } from "./news-desk";
import type { NewsDeskKnobs } from "./news-desk";
import { BOTTOM_LINE_MARKER, DISANALOGY_MARKER, NO_PARALLEL_PHRASE } from "../gates";
import type { BrandProfile, GeneratedPost, LlmClient, SearchClient, Sink } from "../ports";
import type { createDefaultInternals } from "./default";
import type { TrendingStory } from "../sources/google-news";
import type { OutletItem } from "../sources/newswire";
import type { Plan } from "../planning";
import type { GeneratedArticle } from "../pipeline";

const STORY1 = "Senate passes sweeping tariff bill after marathon vote";
const STORY2 = "Central bank raises interest rates to twenty-year high";

async function orchestrationChecks(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  // Fixture trending: story 1 is already covered (ledger below); story 2 is
  // the one the desk must resolve, floor, retell, and publish.
  const trending: TrendingStory[] = [
    { rank: 1, headline: STORY1, leadOutlet: "Wire", coverage: [{ headline: STORY1, outlet: "Wire" }] },
    {
      rank: 2,
      headline: STORY2,
      leadOutlet: "Wire",
      coverage: [
        { headline: "Central bank raises rates to twenty-year high, markets react", outlet: "Beacon" },
        { headline: "Central bank raises interest rates: what it means", outlet: "Teaser Daily" },
      ],
    },
  ];
  // Fixture index: 4 outlets carry story 2 (one on a DEFAULT_BLOCKED_HOSTS
  // host) + one unrelated item that must fall below matchThreshold. Wire
  // appears twice → exercises best-hit-per-outlet.
  const index: OutletItem[] = [
    { outlet: "Wire", region: "US", title: STORY2, url: "https://wire.example/rates" },
    { outlet: "Beacon", region: "US", title: "Central bank raises rates to twenty-year high, markets react", url: "https://beacon.example/rates" },
    { outlet: "Teaser Daily", region: "US", title: "Central bank raises interest rates: what it means", url: "https://teaser.example/rates" },
    { outlet: "Blocked Times", region: "US", title: "Central bank raises interest rates to a twenty-year high", url: "https://www.bloomberg.com/rates" },
    { outlet: "Wire", region: "US", title: "Local team wins championship after dramatic final", url: "https://wire.example/sport" },
  ];
  const REAL = (outlet: string): string =>
    `${outlet} full article body. The central bank raised its policy rate by 50 basis points to a twenty-year high. "We will stay the course," the chair said. Markets fell 2 percent on the announcement. `.repeat(2);
  const PAGES: Record<string, string> = {
    "https://wire.example/rates": REAL("Wire"),
    "https://beacon.example/rates": REAL("Beacon"),
    "https://teaser.example/rates": "Subscribe to continue reading. Create a free account to unlock this article and get unlimited access.",
    "https://www.bloomberg.com/rates": REAL("Blocked Times"),
  };
  const scraped: string[] = [];
  const search: SearchClient = {
    async search(): Promise<never[]> { return []; },
    async scrape(url: string): Promise<string> {
      scraped.push(url);
      const body = PAGES[url];
      if (body === undefined) throw new Error(`no fixture page for ${url}`);
      return body;
    },
  };

  // Routing fake llm: extractEvidence prompts start "TOPIC:"; everything else
  // (the author version + the assembled-markdown fact-check audit) gets a
  // column that satisfies the author-version contract: names the verified
  // parallel, attributes to two outlets, carries both markers, and titles
  // every chapter from its own argument.
  const COLUMN = [
    "## A liquidity halt wearing a modern suit",
    "",
    "The Panic of 1907 is the closest rhyme to this squeeze, and anyone pretending otherwise is selling something. A systemic liquidity halt ended only by a lender of last resort is not a historical curiosity; it is the script this decision is reading from, badly. Wire reports the policy rate went up fifty basis points to a twenty-year high, and the chair said the bank would stay the course. Beacon reports markets fell two percent on the announcement, which is the sound of a room discovering that the course is a cliff.",
    "",
    "That gap between the sentence and the reaction is the whole story. In 1907 the money simply stopped moving, and it took one financier improvising in a library to start it again. The modern version is politer and slower, but the mechanism has not changed: credit freezes when the people holding it stop believing the people who need it.",
    "",
    "## Why the backstop changes the arithmetic",
    "",
    `${DISANALOGY_MARKER} Unlike 1907, today's backstop is institutional. No private financier has to be talked into rescuing anyone at two in the morning, which means the modern squeeze reverses faster and with far less drama. That is a real difference and it deserves to be said plainly, because it is the one thing standing between a hard quarter and a genuine crisis.`,
    "",
    "But institutional does not mean automatic. A backstop that exists on paper and a backstop that is used are different objects, and the distance between them is measured in exactly the kind of hesitation the chair displayed.",
    "",
    "## The rate that will break first",
    "",
    "Fifty basis points is not a policy, it is a flinch. The Wire account makes clear the bank is still fighting the last war, tightening into a market that has already priced the damage.",
    "",
    `${BOTTOM_LINE_MARKER} Central banks will blink first, exactly as they always have since 1907.`,
  ].join("\n");
  // The no-parallel variant for the recentParallels scenario: same story, no
  // historical parallel — carries the NO_PARALLEL_PHRASE verbatim, never
  // names the skipped event, and still satisfies the author-version contract.
  const NO_PARALLEL_COLUMN = [
    "## A squeeze with no honest precedent",
    "",
    `${NO_PARALLEL_PHRASE} That absence is the first honest fact about this decision, and it should discipline every confident analogy being sold tonight. History offers rhymes for almost everything a central bank does; when the record refuses to cough one up, the honest move is to argue the case on the evidence in front of us, which is exactly what the coverage supplies in unusual detail.`,
    "",
    "Wire reports the policy rate went up fifty basis points to a twenty-year high, and the chair promised to stay the course. Beacon reports markets fell two percent on the announcement. Read together, those two sentences describe a bank and a market that no longer believe each other, and nothing in the archive tells us cleanly how that standoff resolves.",
    "",
    "## The cost of tightening into a falling market",
    "",
    "The mechanism is not mysterious. Every additional basis point raises the price of rolling over debt that was priced for a cheaper world, and the firms holding that debt do not get to vote on the schedule. The sell-off Beacon describes is the market repricing that arithmetic in real time, faster than the bank can narrate it.",
    "",
    "A chair who says the course will be stayed is making a promise about the future with tools that only touch the present. That is the wager, stated plainly, and it deserves to be judged as a wager rather than laundered into inevitability.",
    "",
    "## Where the chair's resolve meets the tape",
    "",
    "Resolve is cheap until the tape disagrees. Wire's account makes clear the bank is still fighting the last war, tightening into prices that have already turned, and the two-percent drop is the first invoice for that stubbornness. The polite word for this is discipline; the accurate word is inertia, and inertia is not a policy even when it is delivered in a steady voice. There will be more invoices, and they will arrive faster than the next meeting.",
    "",
    `${BOTTOM_LINE_MARKER} The bank has chosen credibility over flexibility, and it will end up paying for the first with the second before the year is out.`,
  ].join("\n");
  const prompts: string[] = [];
  const llm = {
    async complete(args: { system?: string; prompt: string }): Promise<string> {
      prompts.push(args.prompt);
      if (args.prompt.startsWith("TOPIC:")) return `- fact ("quote", per wire)`;
      // Route on prompt content (the TOPIC: trick): a compose prompt built on
      // the no-parallel path instructs the phrase verbatim — answer with the
      // no-parallel column so the contract's NO_PARALLEL_PHRASE branch holds.
      if (args.prompt.includes(NO_PARALLEL_PHRASE)) return NO_PARALLEL_COLUMN;
      return COLUMN;
    },
    async completeStructured<T>(): Promise<T> {
      return {
        candidates: [{
          era: "1907",
          event: "Panic of 1907",
          actors: ["J.P. Morgan", "Knickerbocker Trust"],
          claimedSimilarity: "a systemic liquidity squeeze halted by a lender of last resort",
        }],
      } as unknown as T;
    },
  } as unknown as LlmClient;

  // Wikipedia REST fakes for the parallelFetchImpl seam. Every call is
  // logged so the recentParallels scenario can assert a skipped candidate
  // cost ZERO encyclopedia fetches.
  const parallelFetches: string[] = [];
  const parallelFetchImpl = (async (url: unknown): Promise<Response> => {
    parallelFetches.push(String(url));
    const u = String(url);
    if (u.includes("action=opensearch")) {
      return new Response(JSON.stringify(["q", ["Panic of 1907"], [""], ["https://en.wikipedia.org/wiki/Panic_of_1907"]]), { status: 200 });
    }
    return new Response(JSON.stringify({
      title: "Panic of 1907",
      extract: "The Panic of 1907 was a United States financial crisis; J. P. Morgan and the Knickerbocker Trust were central, and 1907 marked the turning point.",
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Panic_of_1907" } },
    }), { status: 200 });
  }) as typeof fetch;

  // internalsFactory seam: a stub EngineInternals whose generate proves the
  // fixed retell plan arrived; captures its options so the evidence threading
  // (gatherResearch → the shared corpus) is assertable.
  const internalsOpts: Parameters<typeof createDefaultInternals>[0][] = [];
  const internalsFactory = ((o: Parameters<typeof createDefaultInternals>[0]) => {
    internalsOpts.push(o);
    return {
      discoveryDeps: {} as never,
      generate: async (plan: Plan): Promise<GeneratedArticle> =>
        ({ title: plan.title, content: `retold: ${plan.sections.length} sections`, description: "d" }) as GeneratedArticle,
      slugify: (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      finalizePost: (a: GeneratedArticle, slug: string, topic: string): GeneratedPost =>
        ({ slug, title: a.title, markdown: a.content, telemetry: { topic } }),
    };
  }) as typeof createDefaultInternals;

  const brand: BrandProfile = { name: "Test Desk", publication: "Test Desk (test.invalid)", beat: "news", bylines: ["Desk"] };
  const knobs: NewsDeskKnobs = {
    trendingLimit: 20,
    minSources: 2,
    pagesMax: 6,
    chunkChars: 24_000,
    maxChunksPerPage: 4,
    minContentChars: 40,
    matchThreshold: 0.35,
    coveredThreshold: 0.5,
    parallelCount: 1,
    parallelMinScore: 0.1,
    analysisAttempts: 2,
  };

  const logs: string[] = [];
  const artifacts: { label: string; content: string }[] = [];
  let published: GeneratedPost | null = null;
  const sink: Sink = {
    async publish(post) {
      published = post;
      return { url: `memory://${post.slug}`, status: "DRAFT" as const };
    },
  };

  const post = await createNewsDesk({
    llm,
    search,
    feeds: [],
    persona: PERSONAS.historian,
    brand,
    sink,
    knobs,
    coveredTopics: async () => [{ title: STORY1 }],
    log: (line) => logs.push(line),
    recordArtifact: (label, content) => artifacts.push({ label, content }),
    trendingImpl: async () => trending,
    indexImpl: async () => index,
    internalsFactory,
    parallelFetchImpl,
  }).run();

  ok("story 1 skipped as already covered (threshold ledger match)",
    logs.some((l) => l.includes("already covered") && l.includes(STORY1)), logs.join(" | "));
  ok("blocked host dropped before any scrape (default blocklist)",
    !scraped.includes("https://www.bloomberg.com/rates") && logs.some((l) => l.includes("Blocked Times") && l.includes("blocked host")),
    `scraped=${scraped.join(",")}`);
  ok("teaser outlet dropped with the content-quality floor named in a log line",
    logs.some((l) => l.includes("Teaser Daily") && l.includes("content-quality floor")), logs.join(" | "));

  const md = (published as GeneratedPost | null)?.markdown ?? "";
  // One take per story (operator, 2026-07-24): there is no neutral retell any
  // more — the columnist's own text IS the article body.
  ok("sink received the column directly (no neutral retell wrapper)",
    md.startsWith("## A liquidity halt wearing a modern suit") && !md.includes("retold:"), md.slice(0, 80));
  ok("published markdown carries original chapter titles, never a generic label",
    md.includes("## A liquidity halt wearing a modern suit") && md.includes(DISANALOGY_MARKER), md.slice(0, 200));
  ok("## Sources lists exactly the 2 surviving outlets",
    md.includes("## Sources") && md.includes("- Wire: [") && md.includes("- Beacon: [") &&
      !md.includes("Teaser Daily") && !md.includes("Blocked Times"), md);
  // v2 (operator, 2026-07-23): verification is internal — the reader never
  // sees Wikipedia. Sources must NOT carry an encyclopedia line.
  ok("Sources carries NO Wikipedia line (verification is internal)",
    !md.includes("- Wikipedia:") && !md.includes("wikipedia.org"), md.split("## Sources")[1] ?? md);
  ok("post returned = post published, slug from internals.slugify",
    post === (published as GeneratedPost | null) && post.slug === "central-bank-raises-interest-rates-to-twenty-year-high", post.slug);
  ok("evidence corpus threaded to internals via gatherResearch",
    internalsOpts.length === 1 &&
      ((await internalsOpts[0].gatherResearch?.("any"))?.block ?? "").includes(`SOURCE Wire — ${STORY2} (https://wire.example/rates):`),
    JSON.stringify(internalsOpts.length));
  ok("fact-check audit read the assembled markdown INCLUDING the Analysis",
    prompts.some((p) => p.includes("fact-checker reviewing") && p.includes("## A liquidity halt wearing a modern suit")),
    "no audit prompt carried the Analysis");
  ok("stage artifacts recorded under the stable labels",
    ["trending", "evidence", "parallels", "lead-image", "published"].every((l) => artifacts.some((a) => a.label === l)) &&
      artifacts.some((a) => a.label === `resolution: ${STORY2}`) &&
      artifacts.some((a) => a.label.startsWith("scrape: ")) &&
      artifacts.some((a) => a.label === `author version: ${PERSONAS.historian.name}`) &&
      artifacts.some((a) => a.label === `fact-check-audit: ${PERSONAS.historian.name}`),
    artifacts.map((a) => a.label).join(","));
  ok("scrape artifacts carry the scraped text itself, not just a length marker",
    artifacts.some((a) => a.label === "scrape: Wire" && a.content.includes("full article body")),
    artifacts.filter((a) => a.label.startsWith("scrape: ")).map((a) => a.content.slice(0, 60)).join(" | "));
  ok("default path verified the parallel through the encyclopedia seam",
    parallelFetches.some((u) => u.includes("action=opensearch")) && parallelFetches.some((u) => u.includes("/page/summary/")),
    parallelFetches.join(","));
  ok("published telemetry carries the parallel (hosts feed it back as recentParallels)",
    String(post.telemetry?.parallel) === "Panic of 1907" && String(post.telemetry?.topic) === STORY2,
    JSON.stringify(post.telemetry));

  // Scenario 2 — minSources: 3. Resolution passes (3 unblocked outlets) but the
  // teaser floor leaves 2 survivors < 3 → next story → none left → loud throw.
  let threw = "";
  try {
    await createNewsDesk({
      llm,
      search,
      feeds: [],
      persona: PERSONAS.historian,
      brand,
      sink,
      knobs: { ...knobs, minSources: 3 },
      coveredTopics: async () => [{ title: STORY1 }],
      trendingImpl: async () => trending,
      indexImpl: async () => index,
      internalsFactory,
      parallelFetchImpl,
    }).run();
  } catch (err: unknown) {
    threw = String(err);
  }
  ok("≥3-source floor: no surviving story → loud throw with N interpolated",
    threw.includes("news-desk: no trending story resolved ≥3 scrapable sources"), threw);

  // Scenario 3 — the recentParallels guard (operator, 2026-07-24: the desk
  // kept reaching for the Panic of 1907 week after week). With the just-used
  // list naming the fixture's only candidate, the candidate is skipped before
  // verification (ZERO encyclopedia fetches), no candidate survives, and the
  // published column takes the legal no-parallel path.
  const logs3: string[] = [];
  let published3: GeneratedPost | null = null;
  const fetchesBefore = parallelFetches.length;
  const post3 = await createNewsDesk({
    llm,
    search,
    feeds: [],
    persona: PERSONAS.historian,
    brand,
    sink: {
      async publish(post) {
        published3 = post;
        return { url: `memory://${post.slug}`, status: "DRAFT" as const };
      },
    },
    knobs,
    coveredTopics: async () => [{ title: STORY1 }],
    recentParallels: ["Panic of 1907"],
    log: (line) => logs3.push(line),
    trendingImpl: async () => trending,
    indexImpl: async () => index,
    internalsFactory,
    parallelFetchImpl,
  }).run();
  const md3 = (published3 as GeneratedPost | null)?.markdown ?? "";
  ok("recentParallels: the just-used candidate is skipped with one log line naming it",
    logs3.some((l) => l.includes(`parallels: skipped "Panic of 1907"`)), logs3.join(" | "));
  ok("recentParallels: the skipped candidate costs NO encyclopedia fetch",
    parallelFetches.length === fetchesBefore, `unexpected fetches: ${parallelFetches.slice(fetchesBefore).join(",")}`);
  ok("recentParallels: the published column takes the legal no-parallel path",
    md3.includes(NO_PARALLEL_PHRASE) && !md3.includes("Panic of 1907") &&
      post3.slug === "central-bank-raises-interest-rates-to-twenty-year-high",
    md3.slice(0, 200));
  ok("recentParallels: no-parallel run publishes no telemetry.parallel field",
    post3.telemetry !== undefined && !("parallel" in post3.telemetry) && String(post3.telemetry.topic) === STORY2,
    JSON.stringify(post3.telemetry));

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("news-desk (part 2) checks: all green\n");
}

orchestrationChecks()
  .catch((err: unknown) => {
    process.stderr.write(`news-desk.checks failed: ${String(err)}\n`);
    process.exit(1);
  });
