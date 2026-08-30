import { DATA_PLAYS, FRED_TITLES, PERSONAS, SERP_TITLE_CHARS, applyEditorialLens, checkAuthorVersionContract, createNewsDesk, evidenceWordCap, fredChartUrl, isEnglishHeadline, lineEditAuthorVersion, pickHeadline, stripFurniture, translateHeadline, validateHeadline } from "./news-desk";
import type { NewsDeskKnobs } from "./news-desk";
import { NO_PARALLEL_PHRASE } from "../gates";
import { proposeParallels } from "../parallels";
import type { BrandProfile, GeneratedPost, LlmClient, SearchClient, Sink } from "../ports";
import type { createDefaultInternals } from "./default";
import type { TrendingStory } from "../sources/google-news";
import type { OutletItem } from "../sources/newswire";
import type { Plan } from "../planning";
import type { GeneratedArticle } from "../pipeline";

const STORY1 = "Senate passes sweeping tariff bill after marathon vote";
const STORY2 = "Central bank raises interest rates to twenty-year high";
/** Scenario 5: a cluster with no English headline anywhere. The fixture
 *  translation names only what COLUMN carries, so validateHeadline passes. */
const STORY5 = "La banca centrale alza i tassi al massimo da vent'anni, i mercati crollano";
const TRANSLATION5 = "Central bank rate hike echoes the Panic of 1907";
/** pickHeadline takes the LONGEST real headline that fits 70 chars, so STORY2
 *  publishes under Beacon's cluster headline, not the feed's lead. */
const CHOSEN_SLUG = "central-bank-raises-rates-to-twenty-year-high-markets-react";

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
    "https://hunt-a.example/story": REAL("Hunt A"),
    "https://hunt-b.example/story": REAL("Hunt B"),
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
    "Unlike every panic since, this one arrives with the 1907 lesson already institutionalized, which is exactly why the bank's hesitation is inexcusable: the precedent does not merely rhyme with tonight's decision, it wrote the manual the chair is refusing to open. The mechanism is identical — belief drains faster than liquidity — and 1907 shows both halves: how the freeze starts, and that it ends only when the backstop acts like it means it.",
    "",
    "But institutional does not mean automatic. A backstop that exists on paper and a backstop that is used are different objects, and the distance between them is measured in exactly the kind of hesitation the chair displayed.",
    "",
    "## The rate that will break first",
    "",
    "Fifty basis points is not a policy, it is a flinch. The Wire account makes clear the bank is still fighting the last war, tightening into a market that has already priced the damage.",
    "",
    `Central banks will blink first, exactly as they always have since 1907, and the savers will pay for the flinch.`,
  ].join("\n");
  // The no-parallel variant for the recentParallels scenario: same story, no
  // historical parallel — carries the NO_PARALLEL_PHRASE verbatim, never
  // names the skipped event, and still satisfies the author-version contract.
  // Scenario-4 fixture: same column, but the second attribution names a HUNTED
  // host — the contract's two-outlet floor must hold when sources come from
  // the search hunt rather than the RSS index.
  const HUNT_COLUMN = COLUMN.replace("Beacon reports", "Hunt A reports");
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
    `The bank has chosen credibility over flexibility, and it will end up paying for the first with the second before the year is out.`,
  ].join("\n");
  const prompts: string[] = [];
  const llm = {
    async complete(args: { system?: string; prompt: string }): Promise<string> {
      prompts.push(args.prompt);
      if (args.prompt.startsWith("TOPIC:")) return `- fact ("quote", per wire)`;
      // Route on prompt content (the TOPIC: trick): a compose prompt built on
      // the no-parallel path instructs the phrase verbatim — answer with the
      // no-parallel column so the contract's NO_PARALLEL_PHRASE branch holds.
      if (args.prompt.includes("Hunt A")) return HUNT_COLUMN;
      if (args.prompt.includes(NO_PARALLEL_PHRASE)) return NO_PARALLEL_COLUMN;
      return COLUMN;
    },
    async completeStructured<T>(args: { schemaName?: string }): Promise<T> {
      // Scenario 5 only — English-cluster scenarios never reach translation.
      if (args.schemaName === "wire_headline_translation")
        return { headline: TRANSLATION5 } as unknown as T;
      if (args.schemaName === "parallel_judge")
        return {
          scores: [{
            event: "Panic of 1907",
            score: 84,
            mechanism: "belief drains faster than liquidity, and the freeze ends only when the lender of last resort acts like it means it",
          }],
        } as unknown as T;
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
        ({ slug, title: a.title, markdown: a.content, description: a.description, telemetry: { topic } }),
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
    // Hermetic scenarios skip the echo round; the dedicated unit checks in
    // lensAndEchoChecks() cover it.
    echoCount: 0,
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
    md.includes("## A liquidity halt wearing a modern suit"), md.slice(0, 200));
  ok("the column commits to the parallel — no hedge paragraph (operator, 2026-07-26)",
    !md.includes("Where the parallel breaks down"), md.slice(0, 200));
  // Sources are DATA now, not a chapter: the site renders them for readers,
  // for crawlers that never run JS, and as schema.org citation, and a "##
  // Sources" section in the body reached only the first of the three.
  const cited = (published as GeneratedPost | null)?.sources ?? [];
  ok("sources[] lists exactly the 2 surviving outlets",
    cited.length === 2 &&
      cited.some((c) => c.title.startsWith("Wire: ") && c.url === "https://wire.example/rates") &&
      cited.some((c) => c.title.startsWith("Beacon: ")) &&
      !cited.some((c) => /Teaser Daily|Blocked Times/.test(c.title)),
    JSON.stringify(cited));
  ok("the body no longer carries a ## Sources chapter",
    !md.includes("## Sources"), md.slice(-200));
  // v2 (operator, 2026-07-23): verification is internal — the reader never
  // sees Wikipedia. Sources must NOT carry an encyclopedia line.
  ok("sources carry NO Wikipedia entry (verification is internal)",
    !cited.some((c) => /wikipedia/i.test(c.title) || /wikipedia\.org/.test(c.url)) &&
      !md.includes("wikipedia.org"),
    JSON.stringify(cited));
  ok("dek is the column's first prose sentence — never a chapter heading",
    ((published as GeneratedPost | null)?.description ?? "").startsWith("The Panic of 1907 is the closest rhyme") &&
      !((published as GeneratedPost | null)?.description ?? "").includes("#") &&
      ((published as GeneratedPost | null)?.description ?? "").length <= 200,
    (published as GeneratedPost | null)?.description ?? "(none)");
  // The slug follows pickHeadline, not the feed headline: both the lead
  // ("…raises interest rates to twenty-year high", 53 chars) and Beacon's
  // ("…raises rates to twenty-year high, markets react", 59) fit inside 70, so
  // the longer real headline wins — more information in the space Google will
  // actually show. Still verbatim; a headline no outlet printed is the thing
  // that must never happen.
  ok("post returned = post published, slug follows the CHOSEN headline",
    post === (published as GeneratedPost | null) &&
      post.slug === "central-bank-raises-rates-to-twenty-year-high-markets-react",
    post.slug);
  ok("the chosen title is one an outlet actually printed",
    [STORY2, "Central bank raises rates to twenty-year high, markets react",
     "Central bank raises interest rates: what it means"].includes(post.title),
    post.title);
  ok("evidence corpus threaded to internals via gatherResearch",
    internalsOpts.length === 1 &&
      ((await internalsOpts[0].gatherResearch?.("any"))?.block ?? "").includes(`SOURCE Wire — ${STORY2} (https://wire.example/rates):`),
    JSON.stringify(internalsOpts.length));
  ok("fact-check audit read the assembled markdown INCLUDING the Analysis",
    prompts.some((p) => p.includes("fact-checker reviewing") && p.includes("## A liquidity halt wearing a modern suit")),
    "no audit prompt carried the Analysis");
  ok("the author version is line-edited (Pass 6 wired into the desk)",
    prompts.some((p) => p.startsWith("Line-edit this draft")),
    "no Line-edit prompt was sent");
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
      post3.slug === CHOSEN_SLUG,
    md3.slice(0, 200));
  ok("recentParallels: no-parallel run publishes no telemetry.parallel field",
    post3.telemetry !== undefined && !("parallel" in post3.telemetry) && String(post3.telemetry.topic) === STORY2,
    JSON.stringify(post3.telemetry));

  // Scenario 4 — the source hunt, Google-News-first (operator, 2026-08-16).
  // The index holds ONE outlet. GN coverage names two more real outlets plus a
  // deny-tier impersonator; the impersonator must never be admitted, and the
  // two real ones are resolved by a SITE-RESTRICTED search, so the web search
  // only ever locates a URL on a host GN already vetted. A result that comes
  // back off-host must be discarded.
  const logs4: string[] = [];
  let published4: GeneratedPost | null = null;
  const searched4: string[] = [];
  const post4 = await createNewsDesk({
    llm,
    search: {
      async search(q: string) {
        searched4.push(q);
        // Parallel research still asks plain questions; only the hunt is
        // site-restricted, and it gets back that host's page plus a decoy on
        // another host that the host check must reject.
        if (q.startsWith("site:hunt-a.example")) {
          return [
            { title: "Decoy on the wrong host", url: "https://scraper.example/copy", snippet: "" },
            { title: "Central bank hikes to 20-year high", url: "https://hunt-a.example/story", snippet: "" },
          ];
        }
        if (q.startsWith("site:hunt-b.example")) {
          return [{ title: "Rate rise rocks markets", url: "https://hunt-b.example/story", snippet: "" }];
        }
        if (q.startsWith("site:")) return [];
        return [{ title: "Rates story", url: "https://news.google.com/rss/articles/xyz", snippet: "" }];
      },
      async scrape(url: string): Promise<string> {
        const body = PAGES[url];
        if (body === undefined) throw new Error(`no fixture page for ${url}`);
        return body;
      },
    },
    feeds: [],
    persona: PERSONAS.historian,
    brand,
    sink: {
      async publish(post) {
        published4 = post;
        return { url: `memory://${post.slug}`, status: "DRAFT" as const };
      },
    },
    knobs: { ...knobs, minSources: 3 },
    coveredTopics: async () => [{ title: STORY1 }],
    log: (line) => logs4.push(line),
    trendingImpl: async () => trending,
    indexImpl: async () => [index[0]],
    coverageImpl: async () => [
      { outlet: "Hunt A", host: "hunt-a.example", headline: "Central bank hikes to 20-year high" },
      { outlet: "Hunt B", host: "hunt-b.example", headline: "Rate rise rocks markets" },
      { outlet: "Telegraph Online", host: "telegraph.com", headline: "Rates explained" },
    ],
    internalsFactory,
    parallelFetchImpl,
  }).run();
  const md4 = (published4 as GeneratedPost | null)?.markdown ?? "";
  ok("hunt: web search is SITE-RESTRICTED to hosts Google News named",
    searched4.some((q) => q === "site:hunt-a.example Central bank hikes to 20-year high") &&
      !searched4.includes(STORY2),
    JSON.stringify(searched4));
  ok("hunt: the site-search fan-out is budgeted, not one call per outlet",
    searched4.filter((q) => q.startsWith("site:")).length <= 4,
    `${searched4.filter((q) => q.startsWith("site:")).length} site searches`);
  ok("hunt: a deny-tier outlet in the cluster is never searched or cited",
    !searched4.some((q) => q.includes("telegraph.com")) &&
      !((published4 as GeneratedPost | null)?.sources ?? []).some((c) => c.url.includes("telegraph.com")),
    JSON.stringify(searched4));
  ok("parallel research: the tournament web-researched the verified candidate",
    searched4.some((q) => q.includes("Panic of 1907")), JSON.stringify(searched4));
  ok("hunt: log names the shortfall, the cluster and what resolved",
    logs4.some((l) => l.includes("index gave 1/3") && l.includes("GN coverage named 3 outlet(s) (2 admissible), resolved 2")),
    logs4.join(" | "));
  const cited4 = (published4 as GeneratedPost | null)?.sources ?? [];
  ok("hunt: published with index + GN-vetted hosts; off-host decoy discarded",
    cited4.some((c) => c.title.startsWith("Wire: ")) &&
      cited4.some((c) => c.title.startsWith("Hunt A: ")) &&
      cited4.some((c) => c.title.startsWith("Hunt B: ")) &&
      !cited4.some((c) => c.url.includes("scraper.example")) &&
      !cited4.some((c) => c.url.includes("news.google.com")),
    JSON.stringify(cited4));
  ok("hunt: the run returns the published post",
    post4 === (published4 as GeneratedPost | null) &&
      post4.slug === CHOSEN_SLUG,
    post4.slug);

  // Scenario 5 — a foreign-only cluster publishes under a validated
  // TRANSLATION (operator, 2026-08-30: "if something happened in a foreign
  // country we must definitely translate"). pickHeadline yields no verbatim
  // title; translateHeadline reads the whole cluster and its output is held
  // to validateHeadline against the column; composeHeadline (whose structured
  // call the fixture leaves unhandled → null) falls back to that translation.
  const PAGES5: Record<string, string> = {
    "https://wire5.example/tassi": REAL("Wire"),
    "https://beacon5.example/tassi": REAL("Beacon"),
    "https://canale5.example/tassi": REAL("Canale"),
  };
  const logs5: string[] = [];
  let published5: GeneratedPost | null = null;
  const post5 = await createNewsDesk({
    llm,
    search: {
      async search(q: string) {
        if (q.startsWith("site:")) return [];
        return [{ title: "Rates story", url: "https://news.google.com/rss/articles/xyz", snippet: "" }];
      },
      async scrape(url: string): Promise<string> {
        const body = PAGES5[url];
        if (body === undefined) throw new Error(`no fixture page for ${url}`);
        return body;
      },
    },
    feeds: [],
    persona: PERSONAS.historian,
    brand,
    sink: {
      async publish(post) {
        published5 = post;
        return { url: `memory://${post.slug}`, status: "DRAFT" as const };
      },
    },
    knobs,
    coveredTopics: async () => [],
    log: (line) => logs5.push(line),
    trendingImpl: async () => [
      {
        rank: 1,
        headline: STORY5,
        leadOutlet: "Canale",
        coverage: [
          { outlet: "Gazette FR", headline: "Les marchés chutent après la hausse des taux de la banque centrale" },
          { outlet: "Blatt DE", headline: "Die Zentralbank erhöht die Zinsen auf ein Zwanzigjahreshoch" },
        ],
      },
    ],
    indexImpl: async () => [
      { outlet: "Wire", region: "EU", title: STORY5, url: "https://wire5.example/tassi" },
      { outlet: "Beacon", region: "EU", title: STORY5, url: "https://beacon5.example/tassi" },
      { outlet: "Canale", region: "EU", title: STORY5, url: "https://canale5.example/tassi" },
    ],
    internalsFactory,
    parallelFetchImpl,
  }).run();
  ok("foreign cluster: the story publishes instead of dropping at the title",
    published5 !== null, logs5.join(" | ").slice(-400));
  ok("foreign cluster: the printed title is the VALIDATED translation",
    (published5 as GeneratedPost | null)?.title === TRANSLATION5 &&
      post5.slug === "central-bank-rate-hike-echoes-the-panic-of-1907",
    `${(published5 as GeneratedPost | null)?.title} / ${post5.slug}`);
  ok("foreign cluster: the run logs that a translation carried the title",
    logs5.some((l) => l.includes(`using validated translation: "${TRANSLATION5}"`)),
    logs5.filter((l) => l.includes("headline")).join(" | "));
  ok("foreign cluster: the covered ledger stays keyed to the FEED headline",
    String((published5 as GeneratedPost | null)?.telemetry?.topic) === STORY5,
    JSON.stringify((published5 as GeneratedPost | null)?.telemetry));

  // Chart helper (operator, 2026-07-25: graphs from DataGod series, rendered
  // by a maintained service — never hand-rolled SVG).
  const obs = Array.from({ length: 12 }, (_, i) => ({ date: `2026-0${(i % 9) + 1}-01`, value: String(100 + i) }));
  const chart = fredChartUrl("UNRATE", obs);
  // Dynamic word cap (operator, 2026-07-28): length tracks evidence richness,
  // floored at 500, clamped to the max ceiling.
  ok("evidenceWordCap: a thin 3-source story stays near the 700 floor",
    evidenceWordCap(3, 5000, 1100) === 700, String(evidenceWordCap(3, 5000, 1100)));
  ok("evidenceWordCap: more sources raise the cap",
    evidenceWordCap(5, 5000, 1100) === 900, String(evidenceWordCap(5, 5000, 1100)));
  ok("evidenceWordCap: a large evidence corpus adds a bonus",
    evidenceWordCap(4, 20000, 1100) === 800 + Math.round((20000 - 7000) / 45), String(evidenceWordCap(4, 20000, 1100)));
  ok("evidenceWordCap: never exceeds the max ceiling",
    evidenceWordCap(9, 60000, 1100) === 1100, String(evidenceWordCap(9, 60000, 1100)));

  // Boundary bugs seen live 2026-07-26: mid-word dek chop, mid-word slug cap.
  const { dekFrom } = await import("./news-desk");
  const twoSentences = "They want you looking at the scandal. " + "x".repeat(200);
  ok("dekFrom: a short complete sentence beats a chopped long one",
    dekFrom(twoSentences) === "They want you looking at the scandal.", dekFrom(twoSentences));
  const noBreaks = "word ".repeat(60).trim();
  ok("dekFrom: a breakless paragraph cuts at a word boundary, never mid-word",
    dekFrom(noBreaks).endsWith("word…"), dekFrom(noBreaks));
  ok("fredChartUrl renders a QuickChart line config for a real series",
    chart !== null && chart.startsWith("https://quickchart.io/chart?") &&
      decodeURIComponent(chart).includes(FRED_TITLES.UNRATE) && decodeURIComponent(chart).includes("#e4572e"),
    String(chart).slice(0, 120));
  ok("fredChartUrl refuses a too-thin series (nothing to plot honestly)",
    fredChartUrl("UNRATE", obs.slice(0, 3)) === null && fredChartUrl("UNRATE", [{ date: "2026-01-01", value: "." }]) === null,
    "thin series must yield null");
  // Tier-1 global plays (operator, 2026-07-25): request mapping is the gate —
  // whitelisted codes pass, junk yields null and the play is skipped.
  const play = (id: string) => DATA_PLAYS.find((pl) => pl.id === id);
  ok("worldbank play: whitelisted indicator + ISO country → path; junk → null",
    play("worldbank_indicator")?.request({ seriesId: "FP.CPI.TOTL.ZG", country: "fr" })?.path === "/worldbank/FP.CPI.TOTL.ZG" &&
      play("worldbank_indicator")?.request({ seriesId: "MADE.UP", country: "fr" }) === null &&
      play("worldbank_indicator")?.request({ seriesId: "SP.POP.TOTL", country: "not a code" }) === null,
    JSON.stringify(play("worldbank_indicator")?.request({ seriesId: "FP.CPI.TOTL.ZG", country: "fr" })));
  ok("imf_weo play: ISO3 + WEO code → /imf/WEO/FRA.NGDP_RPCH; junk → null",
    play("imf_weo")?.request({ seriesId: "NGDP_RPCH", country: "fra" })?.path === "/imf/WEO/FRA.NGDP_RPCH" &&
      play("imf_weo")?.request({ seriesId: "NGDP_RPCH", country: "france" }) === null,
    JSON.stringify(play("imf_weo")?.request({ seriesId: "NGDP_RPCH", country: "fra" })));
  ok("eonet play: category whitelist enforced",
    play("eonet_events")?.request({ query: "wildfires" })?.path === "/eonet/events" &&
      play("eonet_events")?.request({ query: "sharknado" }) === null,
    "category gate");
  ok("wikipedia play: entity → encoded summary path, and carries the no-encyclopedia evidence label",
    play("wikipedia_summary")?.request({ query: "Cap Ferret" })?.path === "/wikipedia/summary/Cap%20Ferret" &&
      (play("wikipedia_summary")?.evidenceLabel ?? "").includes("NEVER cite"),
    JSON.stringify(play("wikipedia_summary")?.request({ query: "Cap Ferret" })));
  const edgar = DATA_PLAYS.find((pl) => pl.id === "edgar_filings");
  ok("edgar_filings play maps a ticker to the regulator profile path",
    edgar !== undefined && edgar.request({ ticker: "TSLA" })?.path === "/edgar/company/TSLA" &&
      edgar.request({ ticker: "not a ticker" }) === null && edgar.request({}) === null,
    JSON.stringify(edgar?.request({ ticker: "TSLA" })));

  // ── pickHeadline: still verbatim, just chosen ────────────────────────────
  const story = (headline: string, coverage: string[]): TrendingStory => ({
    rank: 1,
    headline,
    leadOutlet: "BBC",
    coverage: coverage.map((h) => ({ headline: h, outlet: "x" })),
  });

  const LONG = "Senate passes the sweeping tariff bill after a marathon overnight session that split both parties";
  const FITS_LONG = "Senate passes sweeping tariff bill after marathon vote";
  const FITS_SHORT = "Senate passes tariff bill at last";

  ok("picks the LONGEST headline that still fits the SERP limit",
    pickHeadline(story(LONG, [FITS_SHORT, FITS_LONG]), SERP_TITLE_CHARS) === FITS_LONG,
    String(pickHeadline(story(LONG, [FITS_SHORT, FITS_LONG]), SERP_TITLE_CHARS)));

  ok("when nothing fits, takes the shortest so it truncates least",
    pickHeadline(story(LONG, [LONG + " and more besides"]), 20) === LONG,
    String(pickHeadline(story(LONG, [LONG + " and more besides"]), 20)));

  // Length floor removed (operator, 2026-08-30: "remove the ≥25 chars
  // requirement") — a short real English headline beats no headline at all.
  // Before: this cluster's only English wire was filtered for being 23 chars
  // and the desk fell through to the translation path.
  ok("a short English coverage headline is a real candidate — no length floor",
    pickHeadline(story("Los mercados esperan la decisión del banco central", ["Fed holds rates for now"]), SERP_TITLE_CHARS) === "Fed holds rates for now",
    String(pickHeadline(story("Los mercados esperan la decisión del banco central", ["Fed holds rates for now"]), SERP_TITLE_CHARS)));

  // ── validateHeadline: the column may judge, but it may not assert ────────
  const HL_COLUMN =
    "Brussels blinked. The European Commission's tariff climbdown on Tuesday handed Beijing " +
    "exactly what it wanted, and Ursula von der Leyen called it 'a pragmatic settlement'. " +
    "The deal covers 12 categories of goods.";
  const WIRE = "EU strikes tariff deal with China after months of talks";
  const vh = (h: string): string[] =>
    validateHeadline(h, { body: HL_COLUMN, sourceHeadline: WIRE, personaName: "Elena Rossi", maxChars: 70 });

  ok("accepts a headline that argues the column's thesis in its own words",
    vh("Brussels blinked, and Beijing collected the winnings").length === 0,
    vh("Brussels blinked, and Beijing collected the winnings").join("; "));

  ok("judgement words the column never used are FREE — that is what makes it ours",
    vh("Brussels blinked, and the folly of it will be paid for later").length === 0,
    vh("Brussels blinked, and the folly of it will be paid for later").join("; "));

  ok("a number the column does not contain is rejected",
    vh("Brussels blinked on 47 categories of imported goods").some((f) => f.startsWith("number not in")),
    vh("Brussels blinked on 47 categories of imported goods").join("; "));

  ok("a number the column DOES contain is fine",
    vh("Brussels blinked on all 12 categories, and Beijing collected").length === 0,
    vh("Brussels blinked on all 12 categories, and Beijing collected").join("; "));

  // The compose context is now the WHOLE cluster (operator, 2026-08-30: "feed
  // all headlines from qualified sources"), so validateHeadline accepts the
  // wire list: a name any qualified wire printed is admissible, and echoing
  // ANY wire — not just the chosen one — gains nothing and fails.
  const WIRES = [WIRE, "Von der Leyen defends the settlement in Strasbourg"] as const;
  const vhAll = (h: string): string[] =>
    validateHeadline(h, { body: HL_COLUMN, sourceHeadline: WIRES, personaName: "Elena Rossi", maxChars: 70 });

  ok("a name carried only by another wire in the cluster is admissible",
    vhAll("Brussels blinked in Strasbourg, and Beijing collected").length === 0,
    vhAll("Brussels blinked in Strasbourg, and Beijing collected").join("; "));

  ok("echoing ANY wire in the cluster is rejected, not just the chosen one",
    vhAll("Von der Leyen defends the settlement in Strasbourg").some((f) => f.includes("echoes")),
    vhAll("Von der Leyen defends the settlement in Strasbourg").join("; "));

  ok("a name the column never mentions is rejected",
    vh("Brussels blinked, and Macron collected the winnings").some((f) => f.startsWith("name not in")),
    vh("Brussels blinked, and Macron collected the winnings").join("; "));

  ok("a quotation the column never printed is rejected",
    vh('Von der Leyen calls her climbdown "a total triumph" for Europe').some((f) =>
      f.startsWith("quotation not in")),
    vh('Von der Leyen calls her climbdown "a total triumph" for Europe').join("; "));

  ok("echoing the wire headline defeats the point and is rejected",
    vh(WIRE).some((f) => f === "echoes the wire headline"), vh(WIRE).join("; "));

  ok("borrowed furniture and the columnist's own name are rejected",
    vh("Opinion | Brussels blinked and Beijing collected the winnings").some((f) =>
      f.includes("editorial furniture"))
    && vh("Elena Rossi on how Brussels blinked and Beijing collected").some((f) =>
      f === "names the columnist"),
    vh("Opinion | Brussels blinked and Beijing collected the winnings").join("; "));

  ok("a hyphenated name is not a fabricated name — the live desk rejected Mette-Marit for this",
    validateHeadline("Mette-Marit's silence says more than the palace will", {
      body: "The palace insists all is well. Mette-Marit's office declined to comment on the ruling.",
      sourceHeadline: "Norway palace declines to comment on ruling",
      personaName: "Elena Rossi",
      maxChars: 70,
    }).length === 0,
    validateHeadline("Mette-Marit's silence says more than the palace will", {
      body: "The palace insists all is well. Mette-Marit's office declined to comment on the ruling.",
      sourceHeadline: "Norway palace declines to comment on ruling",
      personaName: "Elena Rossi",
      maxChars: 70,
    }).join("; "));

  ok("a possessive is not a fabricated name — apostrophes are ignored on both sides",
    vh("Brussels blinked at the Commission's tariff climbdown").length === 0,
    vh("Brussels blinked at the Commission's tariff climbdown").join("; "));

  ok("a terse headline with no function words is accepted — the English gate is for FEED headlines",
    vh("Brussels blinked, Beijing collected winnings").length === 0,
    vh("Brussels blinked, Beijing collected winnings").join("; "));

  ok("a floating verdict that names nobody is rejected — the reader must know which story it is",
    vh("Trade policy should not ever reward economic coercion").some((f) =>
      f === "names nobody and nothing from the column"),
    vh("Trade policy should not ever reward economic coercion").join("; "));

  ok("a headline ending in a full stop is rejected",
    vh("Brussels blinked and Beijing collected the winnings.").some((f) => f === "ends in a full stop"),
    vh("Brussels blinked and Beijing collected the winnings.").join("; "));

  ok("a headline past the SERP limit is rejected",
    vh("Brussels blinked, Beijing collected the winnings, and the whole continent will pay for it")
      .some((f) => f.startsWith("too long")),
    "len ok");

  // ── stripFurniture: their editorial furniture is a lie about our page ────
  ok("strips an exclusivity claim we never earned",
    stripFurniture("Exclusive: Swedish EU letter reopens the frozen-assets debate")
      === "Swedish EU letter reopens the frozen-assets debate",
    stripFurniture("Exclusive: Swedish EU letter reopens the frozen-assets debate"));

  ok("strips promises of a format this column is not",
    stripFurniture("Live updates: Suspect heads to trial") === "Suspect heads to trial"
    && stripFurniture("Photos: Flood waters close roads") === "Flood waters close roads"
    && stripFurniture("Opinion | The real bonds between the US and Canada")
      === "The real bonds between the US and Canada",
    stripFurniture("Live updates: Suspect heads to trial"));

  ok("strips stacked furniture and a trailing outlet brand",
    stripFurniture("Breaking: Watch: Volcano erupts on Reunion — Reuters") === "Volcano erupts on Reunion",
    stripFurniture("Breaking: Watch: Volcano erupts on Reunion — Reuters"));

  ok("KEEPS attributive qualifiers — stripping one would assert what reporting only reported",
    stripFurniture("Report: Iran enriched uranium past the cap")
      === "Report: Iran enriched uranium past the cap"
    && stripFurniture("Study: Sleep loss tracks with dementia risk")
      === "Study: Sleep loss tracks with dementia risk",
    stripFurniture("Report: Iran enriched uranium past the cap"));

  ok("a headline with no furniture is returned untouched",
    stripFurniture(FITS_LONG) === FITS_LONG, stripFurniture(FITS_LONG));

  ok("pickHeadline cleans the candidates it chooses among",
    pickHeadline(story("x", ["Exclusive: " + FITS_LONG]), SERP_TITLE_CHARS) === FITS_LONG,
    String(pickHeadline(story("x", ["Exclusive: " + FITS_LONG]), SERP_TITLE_CHARS)));

  ok("a feed-truncated candidate is never a title",
    pickHeadline(story(LONG, ["Senate passes sweeping tariff bill after a marathon…"]), SERP_TITLE_CHARS) === LONG,
    String(pickHeadline(story(LONG, ["Senate passes sweeping tariff bill after a marathon…"]), SERP_TITLE_CHARS)));

  ok("no usable candidate falls back to the ENGLISH feed headline unchanged",
    pickHeadline(story("Senate votes on the tariff bill today", []), SERP_TITLE_CHARS) ===
      "Senate votes on the tariff bill today",
    String(pickHeadline(story("Senate votes on the tariff bill today", []), SERP_TITLE_CHARS)));

  ok("the chosen title is always one an outlet actually printed",
    [LONG, FITS_SHORT, FITS_LONG].includes(
      pickHeadline(story(LONG, [FITS_SHORT, FITS_LONG]), SERP_TITLE_CHARS) ?? "",
    ),
    "invented a headline");

  // ── the language gate: an English paper never prints a Spanish title ─────
  // Live 2026-08-14/16: six stories from the per-paper site: feeds published
  // with verbatim Spanish/Portuguese titles over English columns.
  const ES = "Marruecos frustra el intento de cientos de migrantes subsaharianos de alcanzar Ceuta";
  const PT = "Os pedreiros que encontraram tesouro de R$ 5,4 milhões em moedas raras";
  ok("a Spanish headline is not English",
    !isEnglishHeadline(ES) && !isEnglishHeadline(PT) && !isEnglishHeadline("Netanyahu chama Reino Unido de primeira república islâmica"),
    "");
  ok("ordinary English headlines pass, including ones with names and numbers",
    isEnglishHeadline(LONG) && isEnglishHeadline("Hawaii records 140 mph wind gust as hurricane nears") &&
      isEnglishHeadline("Tyson Foods will close or sell three US beef facilities"),
    "");
  ok("an all-foreign cluster yields NO verbatim title — translateHeadline is the desk's fallback",
    pickHeadline(story(ES, [PT]), SERP_TITLE_CHARS) === null,
    String(pickHeadline(story(ES, [PT]), SERP_TITLE_CHARS)));
  ok("a foreign lead with one English headline in the cluster uses the English one",
    pickHeadline(story(ES, ["Morocco blocks hundreds of migrants from reaching the Ceuta enclave"]), SERP_TITLE_CHARS) ===
      "Morocco blocks hundreds of migrants from reaching the Ceuta enclave",
    String(pickHeadline(story(ES, ["Morocco blocks hundreds of migrants from reaching the Ceuta enclave"]), SERP_TITLE_CHARS)));

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("news-desk (part 2) checks: all green\n");
}

/** lineEditAuthorVersion never weakens the gate: the edit ships only inside
 *  the 70–130% band AND still passing the contract; anything else — including
 *  a thrown edit call — keeps the draft. */
async function lineEditChecks(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const FILLER =
    "The evidence in front of us is plain, and the argument follows from it directly enough that a careful reader can retrace every step without leaning on trust. ";
  const DRAFT = [
    "## A rate decision that answers the wrong question",
    "",
    `Wire reports the policy rate rose fifty basis points to a twenty-year high, and Beacon reports markets fell two percent on the announcement. ${FILLER.repeat(8)}The Panic of 1907 is the closest rhyme here, and it argues the freeze ends only when the lender acts like it means it.`,
    "",
    "## Where the chair's promise meets the tape",
    "",
    `${FILLER.repeat(8)}The bank has chosen credibility over flexibility, and it will pay for the first with the second.`,
  ].join("\n");
  const CONTRACT = {
    outletNames: ["Wire", "Beacon"] as const,
    parallelEvent: "Panic of 1907",
    echoEvents: [] as readonly string[],
    wordCap: 700,
    writerName: "Test Writer",
  };
  const stubLlm = (reply: () => Promise<string>) => ({
    complete: async (): Promise<string> => reply(),
    completeStructured: async <T,>(): Promise<T> => {
      throw new Error("unused");
    },
  });

  const POLISHED = DRAFT.replace("plain, and the argument follows", "unmistakable, and the argument follows");
  ok("a contract-passing, in-band edit ships",
    (await lineEditAuthorVersion({ llm: stubLlm(async () => POLISHED), body: DRAFT, contract: CONTRACT })) === POLISHED,
    "the edited version was not kept");
  ok("a whole-body code fence is stripped before judging",
    (await lineEditAuthorVersion({ llm: stubLlm(async () => `\`\`\`markdown\n${POLISHED}\n\`\`\``), body: DRAFT, contract: CONTRACT })) === POLISHED,
    "the fenced edit was not unwrapped and kept");
  ok("an edit that breaks the contract keeps the draft",
    (await lineEditAuthorVersion({
      llm: stubLlm(async () => POLISHED.split("Beacon").join("Bacon")),
      body: DRAFT,
      contract: CONTRACT,
    })) === DRAFT,
    "a one-outlet edit shipped");
  const bandLogs: string[] = [];
  const SHREDDED = DRAFT.split(FILLER.repeat(8)).join(FILLER);
  ok("a shredded edit is rejected by the length band, draft kept",
    (await lineEditAuthorVersion({
      llm: stubLlm(async () => SHREDDED),
      body: DRAFT,
      contract: CONTRACT,
      log: (l) => bandLogs.push(l),
    })) === DRAFT && bandLogs.some((l) => l.includes("outside the 70-130% length band")),
    bandLogs.join(" | "));
  const throwLogs: string[] = [];
  ok("a thrown edit call keeps the draft (best-effort)",
    (await lineEditAuthorVersion({
      llm: stubLlm(async () => {
        throw new Error("model died");
      }),
      body: DRAFT,
      contract: CONTRACT,
      log: (l) => throwLogs.push(l),
    })) === DRAFT && throwLogs.some((l) => l.includes("line edit failed")),
    throwLogs.join(" | "));

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("news-desk line-edit checks: all green\n");
}

/** translateHeadline holds a translation to the printed-title standard:
 *  validateHeadline against the column, English-only output, null on anything
 *  that never validates — the caller skips rather than print it. */
async function translateHeadlineChecks(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const BODY =
    "## The freeze and the flinch\n\nWire reports the policy rate rose fifty basis points to a twenty-year high, and Beacon reports markets fell two percent on the announcement. The Panic of 1907 is the closest rhyme to this squeeze, and the mechanism is identical.\n\n## Where the flinch lands\n\nThe bank has chosen credibility over flexibility, and it will pay for the first with the second.";
  const STORY = {
    rank: 1,
    headline: STORY5,
    leadOutlet: "Canale",
    coverage: [{ outlet: "Gazette FR", headline: "Les marchés chutent après la hausse des taux" }],
  };
  const stub = (replies: string[]) => {
    const queue = [...replies];
    return {
      complete: async (): Promise<string> => {
        throw new Error("unused");
      },
      completeStructured: async <T,>(): Promise<T> => {
        const next = queue.shift();
        if (next === undefined) throw new Error("stub exhausted");
        return { headline: next } as unknown as T;
      },
    } as unknown as LlmClient;
  };
  const argsFor = (llm: LlmClient) => ({
    llm,
    story: STORY,
    body: BODY,
    personaName: "Test Writer",
    maxChars: SERP_TITLE_CHARS,
    maxAttempts: 2,
    log: (_l: string): void => undefined,
  });

  ok("a faithful translation naming only column facts is returned",
    (await translateHeadline(argsFor(stub([TRANSLATION5])))) === TRANSLATION5,
    "valid translation was not returned");
  ok("a translation asserting a name the column lacks is revised, then abandoned",
    (await translateHeadline(argsFor(stub([
      "Central bank panics as Zurich markets crash badly",
      "Central bank panics as Zurich markets crash badly",
    ])))) === null,
    "an unvalidated name shipped");
  ok("non-English output never ships",
    (await translateHeadline(argsFor(stub([STORY5, STORY5])))) === null,
    "a non-English title shipped");
  ok("a throwing model yields null, not a crash",
    (await translateHeadline(argsFor({
      complete: async (): Promise<string> => {
        throw new Error("unused");
      },
      completeStructured: async <T,>(): Promise<T> => {
        throw new Error("model died");
      },
    } as unknown as LlmClient))) === null,
    "throw did not resolve to null");

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("news-desk translate-headline checks: all green\n");
}

/** The 2026-08-30 editorial additions: verified recent echoes (proposal
 *  window + contract rule) and the persona lens (honest gate → guarded
 *  rewrite that can never break the contract). */
async function lensAndEchoChecks(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) {
      process.stdout.write(`PASS ${name}\n`);
    } else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  // ── echo rule: 2+ verified echoes require at least one named ─────────────
  const eCheck = (v: string, echoEvents: readonly string[]): string[] =>
    checkAuthorVersionContract(v, { outletNames: ["Reuters", "AP"], parallelEvent: null, echoEvents, wordCap: 900, writerName: "X" }).failures;
  const NO_ECHO = "## A ledger nobody audited\nwords\n## The bill arrives late\nwords";
  const ONE_ECHO = `${NO_ECHO} — the Paris Agreement chapter of this fight said as much.`;
  const TWO = ["Paris Agreement", "Volkswagen emissions scandal"];
  ok("2+ verified echoes and none named → contract failure",
    eCheck(NO_ECHO, TWO).some((f) => f.includes("recent echo")),
    eCheck(NO_ECHO, TWO).join("; "));
  ok("naming ONE of the echoes satisfies the rule",
    !eCheck(ONE_ECHO, TWO).some((f) => f.includes("recent echo")),
    eCheck(ONE_ECHO, TWO).join("; "));
  ok("a SINGLE verified echo never hard-gates — the prompt alone decides",
    !eCheck(NO_ECHO, ["Paris Agreement"]).some((f) => f.includes("recent echo")),
    eCheck(NO_ECHO, ["Paris Agreement"]).join("; "));

  // ── windowYears bounds the proposal to recent history ────────────────────
  let seenPrompt = "";
  const captureLlm = {
    complete: async (): Promise<string> => "unused",
    completeStructured: async (a: { messages: { content: string }[] }): Promise<unknown> => {
      seenPrompt = a.messages.map((m) => m.content).join("\n");
      return { candidates: [{ era: "2015", event: "Paris Agreement", actors: ["UN"], claimedSimilarity: "enforcement lags the promise" }] };
    },
  } as unknown as LlmClient;
  await proposeParallels({ llm: captureLlm, storySummary: "s", count: 3, windowYears: 20 });
  ok("windowYears turns the proposal recent: the prompt names the 20-year window",
    seenPrompt.includes("past 20 years"), seenPrompt.slice(0, 200));

  // ── applyEditorialLens: honest gate, guarded rewrite ─────────────────────
  const filler = Array.from({ length: 320 }, (_, i) => `w${i}`).join(" ");
  const passing = (tail: string): string =>
    `Reuters reported the fine and AP confirmed the delay. ${NO_PARALLEL_PHRASE}\n\n## The fine that cost less than the crime\n${filler}\n\n## Who is still waiting for the check\nThe county waited ${tail}`;
  const LENS_CONTRACT = { outletNames: ["Reuters", "AP"] as const, parallelEvent: null, echoEvents: [] as readonly string[], wordCap: 900, writerName: "X" };
  const lensPersona = { ...PERSONAS.historian, lens: "THE JUSTICE READ: when harm goes unanswered, press it." };
  const lensLlm = (applies: boolean, rewrite: string): LlmClient =>
    ({
      complete: async (): Promise<string> => rewrite,
      completeStructured: async (): Promise<unknown> => ({ applies, why: "test judgment" }),
    }) as unknown as LlmClient;
  const calm = passing("quietly.");
  const charged = passing("and the waiting is the scandal.");
  ok("no lens on the persona → body untouched",
    (await applyEditorialLens({ llm: lensLlm(true, charged), body: calm, persona: PERSONAS.historian, contract: LENS_CONTRACT })) === calm,
    "body changed without a lens");
  ok("lens judged NOT to apply → body untouched",
    (await applyEditorialLens({ llm: lensLlm(false, charged), body: calm, persona: lensPersona, contract: LENS_CONTRACT })) === calm,
    "body changed on a no");
  ok("lens applies and the rewrite passes the contract → rewrite ships",
    (await applyEditorialLens({ llm: lensLlm(true, charged), body: calm, persona: lensPersona, contract: LENS_CONTRACT })) === charged,
    "valid lens rewrite was not kept");
  ok("a rewrite that breaks the contract is discarded — the lens never breaks the paper",
    (await applyEditorialLens({ llm: lensLlm(true, "just words"), body: calm, persona: lensPersona, contract: LENS_CONTRACT })) === calm,
    "a contract-breaking rewrite shipped");

  if (failures > 0) {
    throw new Error(`${failures} lens/echo check(s) failed`);
  }
  process.stdout.write("news-desk lens+echo checks: all green\n");
}

orchestrationChecks()
  .then(() => lineEditChecks())
  .then(() => translateHeadlineChecks())
  .then(() => lensAndEchoChecks())
  .catch((err: unknown) => {
    process.stderr.write(`news-desk.checks failed: ${String(err)}\n`);
    process.exit(1);
  });
