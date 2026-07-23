import { DATA_PLAYS, PERSONAS, buildRetellPlan, composeAnalysis, createNewsDesk, gatherPrimaryData } from "./news-desk";
import type { NewsDeskKnobs } from "./news-desk";
import { BOTTOM_LINE_MARKER, DISANALOGY_MARKER, NO_PARALLEL_PHRASE } from "../gates";
import type { BrandProfile, GeneratedPost, LlmClient, SearchClient, Sink } from "../ports";
import type { createDefaultInternals } from "./default";
import type { TrendingStory } from "../sources/google-news";
import type { OutletItem } from "../sources/newswire";
import type { Plan } from "../planning";
import type { GeneratedArticle } from "../pipeline";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  ok("three neutral personas ship",
    PERSONAS.historian.name.length > 0 && PERSONAS.realist.method.length > 0 && PERSONAS.systems.voice.length > 0,
    JSON.stringify(Object.keys(PERSONAS)));

  const plan = buildRetellPlan("Tariff bill passes Senate");
  ok("fixed template: exactly the three spec'd sections, no LLM",
    plan.sections.length === 3 &&
      plan.sections[0].heading === "What happened" &&
      plan.sections[1].heading === "The numbers and reactions" &&
      plan.sections[2].heading === "Context" &&
      plan.title === "Tariff bill passes Senate",
    JSON.stringify(plan.sections.map((s) => s.heading)));
  ok("sections carry empty queries (research is the shared evidence corpus)",
    plan.sections.every((s) => s.queries.length === 0), "queries");

  // composeAnalysis: first draft violates the contract, second complies —
  // the retry must feed the failures back into the prompt.
  const GOOD = `## Analysis — ${PERSONAS.historian.name}\n\nChokepoints are leverage, always were. Suez Crisis dynamics apply, and the verdict of that history is unambiguous.\n\n${DISANALOGY_MARKER} Unlike 1956 there is no canal seizure — the modern lever is insurance pricing, which reverses faster than occupations do.\n\n${BOTTOM_LINE_MARKER} Premiums will outlast the shooting, and reroutes will become the map.`;
  let call = 0;
  const seenPrompts: string[] = [];
  const llm = {
    async complete(args: { system?: string; prompt: string }): Promise<string> {
      call += 1;
      seenPrompts.push(args.prompt);
      return call === 1 ? "## My hot take\n\nNo citations here." : GOOD;
    },
    async completeStructured(): Promise<never> { throw new Error("unused"); },
  } as unknown as LlmClient;

  const analysis = await composeAnalysis({
    llm, persona: PERSONAS.historian, evidenceBlock: "SOURCE BBC …\nSOURCE CNN …",
    outletNames: ["BBC", "CNN"],
    parallel: { era: "1956", event: "Suez Crisis", actors: ["Egypt"], claimedSimilarity: "chokepoint",
      wikipediaTitle: "Suez Crisis", wikipediaUrl: "https://en.wikipedia.org/wiki/Suez_Crisis",
      extract: "The 1956 crisis…", score: 0.8 },
    maxAttempts: 3,
  });
  ok("composeAnalysis: retries until the contract passes", call === 2 && analysis === GOOD, `calls=${call}`);
  ok("retry prompt carries the contract failures back to the model",
    seenPrompts[1].includes("previous attempt failed") && seenPrompts[1].includes("bottom line"), seenPrompts[1].slice(0, 200));

  // Honest no-parallel path: the prompt must DEMAND the verbatim phrase.
  let sawPhrase = false;
  const llm2 = {
    async complete(args: { prompt: string }): Promise<string> {
      sawPhrase = args.prompt.includes(NO_PARALLEL_PHRASE);
      return `## Analysis — ${PERSONAS.historian.name}\n\nThe repricing is the story. ${NO_PARALLEL_PHRASE} History without a twin still teaches: premiums are the new blockade.\n\n${BOTTOM_LINE_MARKER} Insurance desks, not admirals, now set the tempo of this conflict.`;
    },
    async completeStructured(): Promise<never> { throw new Error("unused"); },
  } as unknown as LlmClient;
  await composeAnalysis({ llm: llm2, persona: PERSONAS.historian, evidenceBlock: "…",
    outletNames: ["BBC", "CNN"], parallel: null, maxAttempts: 1 });
  ok("no-parallel prompt demands the honest phrase verbatim", sawPhrase, "phrase in prompt");

  // Directed guard: an empty-string parallel event must take the null (honest
  // absence) path — includes("") is vacuously true, so "" would neuter the
  // contract's name check while its prompt demanded a marker for a nameless event.
  let sawPhraseEmpty = false;
  const llm3 = {
    async complete(args: { prompt: string }): Promise<string> {
      sawPhraseEmpty = args.prompt.includes(NO_PARALLEL_PHRASE);
      return `## Analysis — ${PERSONAS.historian.name}\n\nThe repricing is the story. ${NO_PARALLEL_PHRASE} History without a twin still teaches: premiums are the new blockade.\n\n${BOTTOM_LINE_MARKER} Insurance desks, not admirals, now set the tempo of this conflict.`;
    },
    async completeStructured(): Promise<never> { throw new Error("unused"); },
  } as unknown as LlmClient;
  await composeAnalysis({ llm: llm3, persona: PERSONAS.historian, evidenceBlock: "…",
    outletNames: ["BBC", "CNN"],
    parallel: { era: "1956", event: "  ", actors: ["Egypt"], claimedSimilarity: "chokepoint",
      wikipediaTitle: "", wikipediaUrl: "", extract: "", score: 0 },
    maxAttempts: 1 });
  ok("empty parallelEvent treated as honest absence (null path)", sawPhraseEmpty, "empty-event guard");

  // Exhausted attempts throw with the failures.
  const llmBad = {
    async complete(): Promise<string> { return "nope"; },
    async completeStructured(): Promise<never> { throw new Error("unused"); },
  } as unknown as LlmClient;
  let threw = false;
  try {
    await composeAnalysis({ llm: llmBad, persona: PERSONAS.historian, evidenceBlock: "…",
      outletNames: ["BBC", "CNN"], parallel: null, maxAttempts: 2 });
  } catch (err: unknown) {
    threw = String(err).includes("analysis failed the contract");
  }
  ok("exhausted attempts throw with contract context", threw, "throw path");

  // ── gatherPrimaryData: the which-API-when layer (operator, 2026-07-23) ──
  {
    const dgCalls: string[] = [];
    const fakeDg = { async get(path: string): Promise<unknown> { dgCalls.push(path); return { observations: [{ date: "2026-07-01", value: "3.2" }] }; } };
    let menuSeen = false;
    const llmSel = {
      async complete(args: { prompt: string }): Promise<string> {
        // extractEvidence call on the fetched payload
        return args.prompt.includes("3.2") ? "- CPI at 3.2 (2026-07-01)" : "NONE";
      },
      async completeStructured(args: { messages: { content: string }[] }): Promise<unknown> {
        menuSeen = args.messages.some((m) => m.content.includes('id "fred_series"') && m.content.includes("usaspending_search"));
        return { plays: [{ id: "fred_series", seriesId: "CPIAUCSL" }, { id: "nasdaq_price", ticker: "bad ticker!" }] };
      },
    } as unknown as LlmClient;
    const block = await gatherPrimaryData({
      llm: llmSel, datagod: fakeDg, plays: DATA_PLAYS,
      storyHeadline: "Inflation shock", evidenceHead: "coverage says prices rose",
    });
    ok("primary-data: selection prompt carries the full plays menu", menuSeen, "menu");
    ok("primary-data: valid play fetched via whitelisted path",
      dgCalls.length === 1 && dgCalls[0] === "/fred/CPIAUCSL", JSON.stringify(dgCalls));
    ok("primary-data: invalid params rejected mechanically (bad ticker never fetched)",
      !dgCalls.some((c) => c.includes("nasdaq")), JSON.stringify(dgCalls));
    ok("primary-data: block labeled authoritative with extracted figures",
      block.includes("PRIMARY DATA (fred_series") && block.includes("CPI at 3.2"), block.slice(0, 120));
  }
  {
    // fetch failure is non-blocking → empty block
    const fakeDgBad = { async get(): Promise<unknown> { throw new Error("HTTP 502"); } };
    const llmSel2 = {
      async complete(): Promise<string> { return "NONE"; },
      async completeStructured(): Promise<unknown> { return { plays: [{ id: "treasury_debt" }] }; },
    } as unknown as LlmClient;
    const logged: string[] = [];
    const block = await gatherPrimaryData({
      llm: llmSel2, datagod: fakeDgBad, plays: DATA_PLAYS,
      storyHeadline: "Debt ceiling fight", evidenceHead: "…", log: (l) => logged.push(l),
    });
    ok("primary-data: fetch failure is non-blocking and logged",
      block === "" && logged.some((l) => l.includes("non-blocking")), logged.join("|"));
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("news-desk (part 1) checks: all green\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Part 2: createNewsDesk orchestration — offline, EVERY seam injected
// (trendingImpl / indexImpl / internalsFactory / parallelFetchImpl + fake raw
// search + routing fake llm). The REAL orchestration runs end to end.
// ───────────────────────────────────────────────────────────────────────────

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
  // (composeAnalysis + the assembled-markdown fact-check audit) gets a
  // contract-v2-compliant Analysis: names the parallel, cites NO outlets
  // (op-ed direction 2026-07-23), and carries the bottom-line verdict.
  const ANALYSIS = `## Analysis — ${PERSONAS.historian.name}\n\nThe Panic of 1907 is the closest rhyme to this squeeze: a systemic liquidity halt ended only by a lender of last resort, and the lesson has not aged a day.\n\n${DISANALOGY_MARKER} Unlike 1907, today's backstop is institutional — no private financier had to improvise the rescue, so the modern squeeze reverses faster.\n\n${BOTTOM_LINE_MARKER} Central banks will blink first, exactly as they always have since 1907.`;
  const prompts: string[] = [];
  const llm = {
    async complete(args: { system?: string; prompt: string }): Promise<string> {
      prompts.push(args.prompt);
      if (args.prompt.startsWith("TOPIC:")) return `- fact ("quote", per wire)`;
      return ANALYSIS;
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

  // Wikipedia REST fakes for the parallelFetchImpl seam.
  const parallelFetchImpl = (async (url: unknown): Promise<Response> => {
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
  ok("sink received the retell (fixed 3-section plan reached generate)",
    md.startsWith("retold: 3 sections"), md.slice(0, 80));
  ok("published markdown carries the labeled Analysis section",
    md.includes(`## Analysis — ${PERSONAS.historian.name}`) && md.includes(DISANALOGY_MARKER), md.slice(0, 200));
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
    prompts.some((p) => p.includes("fact-checker reviewing") && p.includes(`## Analysis — ${PERSONAS.historian.name}`)),
    "no audit prompt carried the Analysis");
  ok("stage artifacts recorded under the stable labels",
    ["trending", "evidence", "parallels", "analysis", "fact-check-audit", "published"].every((l) => artifacts.some((a) => a.label === l)) &&
      artifacts.some((a) => a.label === `resolution: ${STORY2}`) &&
      artifacts.some((a) => a.label.startsWith("scrape: ")),
    artifacts.map((a) => a.label).join(","));

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

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("news-desk (part 2) checks: all green\n");
}

main()
  .then(() => orchestrationChecks())
  .catch((err: unknown) => {
    process.stderr.write(`news-desk.checks failed: ${String(err)}\n`);
    process.exit(1);
  });
