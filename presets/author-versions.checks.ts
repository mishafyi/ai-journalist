/**
 * author-versions.checks.ts — the fused author-versions format (operator,
 * 2026-07-23): checkAuthorVersionContract mechanics, composeAuthorVersion's
 * retry-until-contract loop, and the createNewsDesk({authorVersions}) branch:
 * NO neutral retell, one complete capped column per persona published as its
 * own post — title = trending headline verbatim, slug suffixed, persona byline.
 *
 * Run: npx tsx presets/author-versions.checks.ts
 */
import { BOTTOM_LINE_MARKER, DISANALOGY_MARKER, NO_PARALLEL_PHRASE } from "../gates";
import type { GeneratedArticle } from "../pipeline";
import type { BrandProfile, GeneratedPost, LlmClient, PersonaProfile, SearchClient, Sink } from "../ports";
import type { TrendingStory } from "../sources/google-news";
import type { OutletItem } from "../sources/newswire";
import type { createDefaultInternals } from "./default";
import {
  checkAuthorVersionContract,
  composeAuthorVersion,
  createNewsDesk,
  PERSONAS,
  type NewsDeskKnobs,
} from "./news-desk";

let failures = 0;
const ok = (name: string, cond: boolean, detail: string): void => {
  if (cond) process.stdout.write(`PASS ${name}\n`);
  else {
    failures += 1;
    process.stdout.write(`FAIL ${name} — ${detail}\n`);
  }
};

// A contract-passing fixture column: ≥300 words, 2 outlets, parallel +
// disanalogy + bottom line, prose only.
const FILLER =
  "The pattern holds because incentives, not personalities, drive the outcome, and the incentives here have not changed since the first vote was counted. ";
const GOOD_BODY = [
  `Wire reports that the central bank raised its policy rate by 50 basis points to a twenty-year high, and per Beacon, markets fell 2 percent on the announcement. "We will stay the course," the chair said.`,
  `The Panic of 1907 is the closest rhyme to this squeeze: a systemic halt ended only by a lender of last resort, and the lesson has not aged a day. ${FILLER.repeat(12)}`,
  `${DISANALOGY_MARKER} Unlike 1907, today's backstop is institutional — no private financier had to improvise the rescue. ${FILLER.repeat(8)}`,
  `${BOTTOM_LINE_MARKER} Central banks will blink first, exactly as they always have since 1907, and savers will pay for the blink.`,
].join("\n\n");

function contractChecks(): void {
  const args = { outletNames: ["Wire", "Beacon", "Teaser Daily"], parallelEvent: "Panic of 1907", wordCap: 600 };
  ok("contract: the good fixture passes", checkAuthorVersionContract(GOOD_BODY, args).ok,
    checkAuthorVersionContract(GOOD_BODY, args).failures.join(" | "));

  const single = checkAuthorVersionContract(GOOD_BODY.replace(/Beacon/g, "the wires"), args);
  ok("contract: <2 outlet mentions fails with the count named",
    !single.ok && single.failures.some((f) => f.includes("at least 2 outlets")), single.failures.join(" | "));

  const noBottom = checkAuthorVersionContract(GOOD_BODY.replace(BOTTOM_LINE_MARKER, "**In sum:**"), args);
  ok("contract: missing bottom-line marker fails",
    !noBottom.ok && noBottom.failures.some((f) => f.includes(BOTTOM_LINE_MARKER)), noBottom.failures.join(" | "));

  const thin = checkAuthorVersionContract(
    `${GOOD_BODY.split(BOTTOM_LINE_MARKER)[0]}${BOTTOM_LINE_MARKER} Fine.`, args);
  ok("contract: bottom-line verdict under 40 chars fails",
    !thin.ok && thin.failures.some((f) => f.includes("too thin")), thin.failures.join(" | "));

  const noParallel = checkAuthorVersionContract(GOOD_BODY.replace(/Panic of 1907/g, "that old crisis"), args);
  ok("contract: verified parallel unnamed fails",
    !noParallel.ok && noParallel.failures.some((f) => f.includes("must name the verified parallel")),
    noParallel.failures.join(" | "));

  const noDis = checkAuthorVersionContract(GOOD_BODY.replace(DISANALOGY_MARKER, "But note:"), args);
  ok("contract: missing disanalogy paragraph fails",
    !noDis.ok && noDis.failures.some((f) => f.includes(DISANALOGY_MARKER)), noDis.failures.join(" | "));

  const absent = checkAuthorVersionContract(GOOD_BODY, { ...args, parallelEvent: null });
  ok("contract: null parallel demands the absence phrase verbatim",
    !absent.ok && absent.failures.some((f) => f.includes(NO_PARALLEL_PHRASE)), absent.failures.join(" | "));
  ok("contract: null parallel + absence phrase passes",
    checkAuthorVersionContract(`${GOOD_BODY} ${NO_PARALLEL_PHRASE}`, { ...args, parallelEvent: null }).ok,
    checkAuthorVersionContract(`${GOOD_BODY} ${NO_PARALLEL_PHRASE}`, { ...args, parallelEvent: null }).failures.join(" | "));

  const over = checkAuthorVersionContract(`${GOOD_BODY} ${FILLER.repeat(20)}`, args);
  ok("contract: over the word cap fails with cap named",
    !over.ok && over.failures.some((f) => f.includes("cap 600")), over.failures.join(" | "));

  const short = checkAuthorVersionContract(
    `Wire and Beacon report a hike. Panic of 1907. ${DISANALOGY_MARKER} n/a. ${BOTTOM_LINE_MARKER} A verdict long enough to clear the forty character floor easily.`, args);
  ok("contract: under the 300-word floor fails",
    !short.ok && short.failures.some((f) => f.includes("floor 300")), short.failures.join(" | "));

  // Live failure 2026-07-23: Wikipedia spells "Smoot–Hawley" with an en dash;
  // a column copying the record's spelling must pass an ASCII-spelled contract.
  const enDash = checkAuthorVersionContract(
    GOOD_BODY.replace(/Panic of 1907/g, "Smoot–Hawley Tariff Act"),
    { ...args, parallelEvent: "Smoot-Hawley Tariff Act" });
  ok("contract: en-dash column satisfies ASCII-hyphen parallel (typography-insensitive)",
    enDash.ok, enDash.failures.join(" | "));

  // Second live false-negative (2026-07-23): "the Dust Bowl" in prose must
  // satisfy event "The Dust Bowl" (case + leading article), and lowercase
  // outlet mentions must count as attribution ("the guardian reports").
  const dustBowl = checkAuthorVersionContract(
    GOOD_BODY.replace(/Panic of 1907/g, "the Dust Bowl"),
    { ...args, parallelEvent: "The Dust Bowl" });
  ok("contract: 'the Dust Bowl' in prose satisfies event 'The Dust Bowl'",
    dustBowl.ok, dustBowl.failures.join(" | "));
  const lcOutlets = checkAuthorVersionContract(
    GOOD_BODY.replace("Wire reports", "wire reports").replace("per Beacon", "per beacon"),
    args);
  ok("contract: lowercase outlet mentions count as attribution",
    lcOutlets.ok, lcOutlets.failures.join(" | "));

  const wiki = checkAuthorVersionContract(GOOD_BODY.replace("rhyme to this squeeze", "rhyme, as Wikipedia notes"), args);
  ok("contract: encyclopedia mention fails",
    !wiki.ok && wiki.failures.some((f) => f.includes("Wikipedia")), wiki.failures.join(" | "));

  const headed = checkAuthorVersionContract(`## My column\n\n${GOOD_BODY}`, args);
  ok("contract: headings fail (prose only)",
    !headed.ok && headed.failures.some((f) => f.includes("no headings")), headed.failures.join(" | "));
}

async function composeChecks(): Promise<void> {
  // First attempt violates (no bottom line), second passes → 2 calls, retry
  // prompt carries the failure text.
  const answers = [GOOD_BODY.replace(BOTTOM_LINE_MARKER, "**In sum:**"), GOOD_BODY];
  const prompts: string[] = [];
  const llm = {
    async complete(a: { prompt: string }): Promise<string> {
      prompts.push(a.prompt);
      return answers[prompts.length - 1] ?? GOOD_BODY;
    },
  } as unknown as LlmClient;
  const out = await composeAuthorVersion({
    llm, persona: PERSONAS.historian, storyHeadline: "h", evidenceBlock: "…",
    outletNames: ["Wire", "Beacon"],
    parallel: { event: "Panic of 1907", era: "1907", actors: ["J.P. Morgan"], claimedSimilarity: "s", wikipediaTitle: "t", wikipediaUrl: "u", extract: "e", score: 1 },
    wordCap: 600, maxAttempts: 3,
  });
  ok("compose: contract failure retries once then returns the passing column",
    out === GOOD_BODY && prompts.length === 2 && (prompts[1] ?? "").includes(BOTTOM_LINE_MARKER),
    `calls=${prompts.length}`);
  ok("compose: the retry REVISES the previous draft (draft included, revise instruction)",
    (prompts[1] ?? "").includes("YOUR PREVIOUS DRAFT") && (prompts[1] ?? "").includes("**In sum:**") &&
      (prompts[1] ?? "").includes("REVISE the draft above"),
    (prompts[1] ?? "").slice(0, 120));

  let threw = "";
  try {
    await composeAuthorVersion({
      llm: { async complete(): Promise<string> { return "too short"; } } as unknown as LlmClient,
      persona: PERSONAS.historian, storyHeadline: "h", evidenceBlock: "…",
      outletNames: ["Wire", "Beacon"], parallel: null, wordCap: 600, maxAttempts: 2,
    });
  } catch (err: unknown) {
    threw = String(err);
  }
  ok("compose: exhausted attempts throw loudly with the persona named",
    threw.includes("author version") && threw.includes(PERSONAS.historian.name) && threw.includes("2 attempts"), threw);
}

// ── Orchestration: the authorVersions branch through the fake harness ──────
const STORY = "Central bank raises interest rates to twenty-year high";

async function orchestrationChecks(): Promise<void> {
  const trending: TrendingStory[] = [
    { rank: 1, headline: STORY, leadOutlet: "Wire", coverage: [{ headline: `${STORY}, markets react`, outlet: "Beacon" }] },
  ];
  const index: OutletItem[] = [
    { outlet: "Wire", region: "US", title: STORY, url: "https://wire.example/rates" },
    { outlet: "Beacon", region: "US", title: `${STORY}, markets react`, url: "https://beacon.example/rates" },
  ];
  const REAL = (outlet: string): string =>
    `${outlet} full article body. The central bank raised its policy rate by 50 basis points to a twenty-year high. "We will stay the course," the chair said. Markets fell 2 percent on the announcement. `.repeat(2);
  const search: SearchClient = {
    async search(): Promise<never[]> { return []; },
    async scrape(url: string): Promise<string> {
      return url.includes("wire") ? REAL("Wire") : REAL("Beacon");
    },
  };
  const llm = {
    async complete(args: { prompt: string }): Promise<string> {
      if (args.prompt.startsWith("TOPIC:")) return `- fact ("quote", per wire)`;
      return GOOD_BODY;
    },
    async completeStructured<T>(): Promise<T> {
      return {
        candidates: [{ era: "1907", event: "Panic of 1907", actors: ["J.P. Morgan"], claimedSimilarity: "a systemic squeeze halted by a lender of last resort" }],
      } as unknown as T;
    },
  } as unknown as LlmClient;
  const parallelFetchImpl = (async (url: unknown): Promise<Response> => {
    const u = String(url);
    if (u.includes("action=opensearch")) {
      return new Response(JSON.stringify(["q", ["Panic of 1907"], [""], ["https://en.wikipedia.org/wiki/Panic_of_1907"]]), { status: 200 });
    }
    return new Response(JSON.stringify({
      title: "Panic of 1907",
      extract: "The Panic of 1907 was a United States financial crisis; a systemic squeeze halted by a lender of last resort.",
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Panic_of_1907" } },
    }), { status: 200 });
  }) as typeof fetch;

  let generateCalls = 0;
  const internalsFactory = ((o: Parameters<typeof createDefaultInternals>[0]) => {
    void o;
    return {
      discoveryDeps: {} as never,
      generate: async (): Promise<GeneratedArticle> => {
        generateCalls += 1;
        return { title: "x", content: "x", description: "d" } as GeneratedArticle;
      },
      slugify: (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      finalizePost: (a: GeneratedArticle, slug: string, topic: string): GeneratedPost =>
        ({ slug, title: a.title, markdown: a.content, byline: "brand-random", telemetry: { topic } }),
    };
  }) as typeof createDefaultInternals;

  const second: PersonaProfile = { ...PERSONAS.historian, name: "Grant Colby", bio: "b. 1961, Amarillo — fixture bio." };
  const third: PersonaProfile = { ...PERSONAS.historian, name: "Dana Whitfield" }; // no bio → no marker line
  const posts: GeneratedPost[] = [];
  const artifacts: { label: string; content: string }[] = [];
  const sink: Sink = {
    async publish(post) {
      posts.push(post);
      return { url: `memory://${post.slug}`, status: "DRAFT" as const };
    },
  };
  const brand: BrandProfile = { name: "Test Desk", publication: "Test Desk (test.invalid)", beat: "news", bylines: ["Desk"] };
  const knobs: NewsDeskKnobs = {
    trendingLimit: 20, minSources: 2, pagesMax: 6, chunkChars: 24_000, maxChunksPerPage: 4,
    minContentChars: 40, matchThreshold: 0.35, coveredThreshold: 0.5,
    parallelCount: 1, parallelMinScore: 0.1, analysisAttempts: 2,
  };

  const returned = await createNewsDesk({
    llm,
    search,
    feeds: [],
    persona: { ...PERSONAS.historian, name: "Maya Ellison", bio: "b. 1996, Flint — fixture bio." },
    personas: [second, third],
    authorVersions: { wordCap: 600 },
    brand,
    sink,
    knobs,
    recordArtifact: (label, content) => artifacts.push({ label, content }),
    trendingImpl: async () => trending,
    indexImpl: async () => index,
    internalsFactory,
    parallelFetchImpl,
  }).run();

  ok("three posts published — one per columnist", posts.length === 3, `got ${posts.length}`);
  ok("every title is the trending headline verbatim (source-optimized, never model-invented)",
    posts.every((p) => p.title === STORY), posts.map((p) => p.title).join(" | "));
  ok("slugs share the headline base and carry the author suffix",
    posts.map((p) => p.slug).join(",") ===
      "central-bank-raises-interest-rates-to-twenty-year-high-maya,central-bank-raises-interest-rates-to-twenty-year-high-grant,central-bank-raises-interest-rates-to-twenty-year-high-dana",
    posts.map((p) => p.slug).join(","));
  // Bylines are the columnist's plain name — the paper reads as a newspaper,
  // and the brand's random byline is overridden (operator, 2026-07-24).
  ok("bylines are the columnist's plain name (brand random byline overridden)",
    posts.map((p) => p.byline).join("|") === "Maya Ellison|Grant Colby|Dana Whitfield",
    posts.map((p) => p.byline).join("|"));
  // No persona/disclosure preamble is embedded in the article body — every
  // version opens on its own first sentence (operator, 2026-07-24).
  ok("no persona preamble: every version opens on its own prose",
    posts.every((p) => !p.markdown.includes("AI columnist persona") && p.markdown.startsWith("Wire reports")),
    posts.map((p) => p.markdown.slice(0, 40)).join(" | "));
  ok("every version carries ## Sources with both surviving outlets",
    posts.every((p) => p.markdown.includes("## Sources") && p.markdown.includes("- Wire: [") && p.markdown.includes("- Beacon: [")),
    posts[0]?.markdown.slice(-200) ?? "");
  ok("NO neutral retell in this mode (internals.generate never called)", generateCalls === 0, `generate called ${generateCalls}×`);
  ok("run() returns the last published post", returned === posts[2], returned.slug);
  ok("per-author artifacts recorded (author version + fact-check-audit + published ×3)",
    ["Maya Ellison", "Grant Colby", "Dana Whitfield"].every((n) => artifacts.some((a) => a.label === `author version: ${n}`)) &&
      artifacts.filter((a) => a.label === "published").length === 3,
    artifacts.map((a) => a.label).join(","));
}

async function main(): Promise<void> {
  contractChecks();
  await composeChecks();
  await orchestrationChecks();
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("author-versions checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`author-versions.checks failed: ${String(err)}\n`);
  process.exit(1);
});
