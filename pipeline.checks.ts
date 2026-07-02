/**
 * Checks for pipeline.ts — run: npx tsx pipeline.checks.ts
 *
 * The golden guard (services/blog/__tests__/golden.test.ts) replays LLM OUTPUTS
 * by call-order, so it proves the right NUMBER of calls fire in the right stage
 * order + a byte-stable final article — but it does NOT byte-check the prompts
 * of the inline surgical-fix passes runGeneration sends. This check is the
 * byte-lock for those prompts + the `chatCompletion([{role:"user",content}],
 * {model,temperature})` → `deps.llm.complete({prompt,model,temperature})`
 * conversion 8d performed.
 *
 * Method: drive `runGeneration` ONCE with a fully-stubbed `PipelineDeps`. The
 * `llm` CAPTURES every prompt keyed by the `withRetry` label that wraps it
 * (first occurrence per label → the pass-1, non-enumerated form). The article
 * fed to the surgical passes is an immutable all-gates fixture (the stubbed
 * `lengthSafe` returns its INPUT, so the running article never mutates) chosen so
 * the inline detectors (countProseDashes / extractFigures / countAttribTags /
 * the stale-date + first-party scanners) each trip; the dep-driven detectors
 * (countVagueBanding / findRepeatedShingles / emdashClusteredLines) are rigged to
 * trip too. Then each captured prompt is asserted byte-identical to a verbatim
 * reference rendered from the SAME fixed inputs — catching any template-literal
 * or interpolated-knob drift the golden replay can't see, and locking the
 * user-only + temperature-0.3 conversion.
 *
 * SCOPE: this byte-locks the 6 surgical passes whose prompts render
 * DETERMINISTICALLY from the fixture — banding, repetition (pass-1), em-dash,
 * table, attribution (pass-1), and decluster. Three passes are intentionally
 * NOT byte-locked here and are covered instead by the source-level byte-diff
 * (task-8d-report.md) + the golden replay:
 *   - attribution-floor-fix — its precondition (few named sources) is mutually
 *     exclusive with attribution-fix's (many tags) on one immutable article;
 *   - stale-date-fix — its prompt interpolates `new Date()` (run-clock);
 *   - first-party-fix — niche; its prompt is plain (no inline detector counts).
 */
import {
  runGeneration,
  neutralEnrichment,
  type PipelineDeps,
  type PipelineBoardCompany,
} from "./pipeline";
import { type GateDeps } from "./gates";
import { type Plan } from "./planning";
import { type RunContext } from "./run-context";
import { type LlmClient } from "./ports";
import { splitSentences } from "./text";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${name}${detail ? `\n  ${detail}` : ""}\n`);
  }
}

// Silence runGeneration's heavy progress logging; keep a raw writer for results.
const realWrite = process.stdout.write.bind(process.stdout);
function log(s: string): void {
  realWrite(s);
}

// ── Minimal board-company type for the generic ──────────────────────────────
interface MinBoard {
  company: string;
  url: string;
  addedInWindow: number;
  jobs: { title: string; location: string | null; salary: string | null }[];
}

// ── Fixed inputs (the byte-lock references render from these EXACT values) ──
const MODEL = "test-model";
const ATTRIB_TAG_MAX = 4;
// >repeatTrigger(3) distinct phrases so the repetition pass fires.
const REPEAT_PHRASES = [
  "a repeated six word phrase here",
  "another repeated six word phrase here",
  "a third repeated phrase appears twice",
  "a fourth repeated phrase shows up",
];
// All-gates fixture: trips countProseDashes(9 > cap 6), dollarFigures(11 ≥ 4) +
// 0 tables, countAttribTags(5 > 4), a stale future-tense date, and a first-party
// "Example News $999k" sentence. Probed against the real detectors.
const ARTICLE = [
  "## Market Overview",
  "",
  "Engineers here are paid well and competitive salaries are common, with strong wages and six figures the norm.",
  "Roles pay $120k according to Levels, and per Glassdoor the range hits $180k.",
  "According to Payscale the median is $95k, and according to LinkedIn senior staff clear $250k per Indeed.",
  "Example News lists $999k roles for the top tier.",
  "The new program will launch on January 1, 2020 with full staffing.",
  "Funding reached $5M — while the market grew 40 percent — and margins rose 12 percent — sharply.",
  "Some teams earn $300k — others $80k — and contractors bill $150k — per project — across the board.",
  "Analysts peg the TAM at $2B — and forecasts show 25 percent CAGR — with $400k exec packages.",
].join("\n");

// Research blocks the body builds: datagodBlock = "" (stub), boardData = [] so
// boardFactsTruth = "", and the site-inventory line is EMPTY here — this fixture
// feeds all-zeros site data (jobCount/companyCount = 0), which trips the
// empty-guard that skips the "tracks 0 open roles across 0 companies" block (it
// would inject a false "verified" fact into the ground truth). So boardTruth =
// "". research = the section writer's pooled string (stubbed empty → "").
const DATAGOD = "";
const RESEARCH = "";
const BOARD_TRUTH = "";

// The exact interpolated counts the inline detectors report on the fixture.
const VAGUE_COUNT = 5; // dep-rigged
const EMDASH_COUNT = 9;
const EMDASH_CAP = 6;
const DOLLAR_FIGURES = 11;
const ATTRIB_COUNT = 5;
const CLUSTERED = 1; // dep-rigged

// ── Captured prompts, keyed by withRetry label (first occurrence wins) ──────
interface Captured {
  system?: string;
  prompt: string;
  model?: string;
  temperature?: number;
}
const captures = new Map<string, Captured>();
let captureLabel = "";

const capturingLlm: LlmClient = {
  complete: async (args) => {
    if (captureLabel && !captures.has(captureLabel)) {
      captures.set(captureLabel, { ...args });
    }
    return ARTICLE; // article-shaped; the stubbed lengthSafe returns INPUT anyway
  },
  // The structured passes (title/seo) run AFTER assembly, downstream of the tail
  // shape-assert this tiny fixture trips — so this rarely fires. When it does,
  // return a schema-valid object (json_schema would have guaranteed one). This
  // check asserts only the inline surgical-fix prompts (all free-text), so the
  // structured passes are not under test here.
  completeStructured: async (args) =>
    args.schema.parse(
      args.schemaName === "headline_candidates"
        ? {
            candidates: ["A candidate headline here"],
            best: "A candidate headline here",
          }
        : {
            title: "T",
            description: "d",
            seoTitle: "s",
            seoDescription: "sd",
            tags: ["x"],
            keywords: ["y"],
          },
    ),
};

const withRetry: PipelineDeps<MinBoard>["withRetry"] = async (label, fn) => {
  captureLabel = label;
  try {
    return await fn();
  } finally {
    captureLabel = "";
  }
};

function makeCtx(): RunContext {
  return {
    runId: "run_pipeline_checks",
    telemetry: { mode: "topic", llmCalls: [], retries: [] },
    runArtifacts: [],
    recordArtifact: () => {},
    recordLlmCall: () => {},
    recordRetry: () => {},
  } as unknown as RunContext;
}
const ctx = makeCtx();

function makeGateDeps(): GateDeps {
  return {
    llm: capturingLlm,
    model: MODEL,
    withRetry,
    ctx,
    gatherExemplars: () => [],
    fetchPriorTitles: async () => [],
    embedDedupSurvivors: async () => null,
    titleExemplarCount: 0,
    titleCollisionSim: 0.45,
    titleEmbedSim: 0.9,
    searchTermsCount: 0,
  };
}

const blogDeps = {
  llm: capturingLlm,
  gatherSignal: async () => ({ items: [] }),
  searchSnippets: async () => [],
  gatherResearch: async () => ({ text: "", sources: [] }),
  gatherCoveredTopics: async () => [],
  embedDedupSurvivors: async () => null,
  withRetry,
  getRunId: () => "run_pipeline_checks",
  systemPrompt: () => "SYS",
  runEdit: async (s: string) => s,
  runFinalEdit: async (s: string) => s,
  onEvent: async () => {},
  onError: () => {},
  // Section-writer knobs (now injected, no engine env): model + stable defaults.
  model: MODEL,
  sectionSnippets: 4,
  sectionConcurrency: 3,
  brandName: "Example News",
} as unknown as PipelineDeps<MinBoard>["blogDeps"];

const repeatFired = { n: 0 };
const vagueFired = { n: 0 };
const clusterFired = { n: 0 };

const deps: PipelineDeps<MinBoard> = {
  llm: capturingLlm,
  model: MODEL,
  withRetry,
  gateDeps: makeGateDeps(),
  blogDeps,
  ctx,
  // Domain enrichment (data gathers + link tail + jobs helpers) — the fields
  // that moved out of PipelineDeps into PipelineEnrichment. Values unchanged.
  enrichment: {
    gatherSiteData: async () => ({
      companies: [],
      people: [],
      jobCount: 0,
      companyCount: 0,
      domain: { label: "frontier tech" },
    }),
    gatherLinkableEntities: async () => ({ companies: [], people: [] }),
    gatherIndustryFreshHirers: async () => [],
    gatherCompanyFreshJobs: async () => [],
    gatherDatagodFacts: async () => DATAGOD,
    resolveArticleEntities: async () => [],
    linkEntities: (content) => content,
    withInternalLinks: (article) => article,
    enforceLinkIntegrity: async (content) => ({ content, stats: {} }),
    boardJobsLine: () => "",
    usLeanLocations: () => true,
    shortForm: () => null,
    linkNameStoplist: new Set<string>(),
    enrichLimit: 6,
    linkCompanyLimit: 500,
    linkPeopleLimit: 100,
    topicCompanies: 3,
    topicCompanyJobs: 6,
    topicJobsWindowHours: 168,
  },
  // Immutable article: every surgical pass's `input`/output stays the fixture.
  stripPreambleAndFence: (t) => t,
  isArticleShaped: () => true,
  lengthSafe: (_label, input) => input,
  // Dep-driven detectors rigged to fire pass-1 only.
  countVagueBanding: () => (vagueFired.n++ === 0 ? VAGUE_COUNT : 0),
  dropDuplicateSentences: (text) => ({ text, dropped: 0 }),
  findRepeatedShingles: () => (repeatFired.n++ === 0 ? REPEAT_PHRASES : []),
  shingleOccurrences: () => [],
  emdashClusteredLines: () => (clusterFired.n++ === 0 ? CLUSTERED : 0),
  recordArtifact: () => {},
  onEvent: async () => {},
  metaProseRe: /__never__/,
  cotPrefixRe: /__never__/,
  preambleLineRe: /__never__/,
  // Brand name = the exact generic short form, so boardTruth + the first-party-fix
  // prompt resolve to the byte-identical reference strings (BOARD_TRUTH above).
  brandName: "Example News",
  researchPersistChars: 200000,
  repeatShingleWords: 6,
  repeatTrigger: 3,
  sentenceDedupMinChars: 40,
  clauseDedupMinChars: 40,
  emdashMaxEnv: null,
  tableMinFigures: 4,
  attribTagMax: ATTRIB_TAG_MAX,
  draftWordWarnFloor: 1500,
};

const PLAN: Plan = {
  title: "Test Title",
  angle: "test angle",
  category: "frontier",
  searchSeed: "test seed",
  sections: [{ heading: "Section One", intent: "cover it", queries: [] }],
};

// ── Verbatim reference prompts (rendered from the fixed inputs above) ────────
const researchTail = (limit: number): string =>
  RESEARCH.slice(0, Math.max(0, limit - DATAGOD.length - BOARD_TRUTH.length));

// The exact sentence lists the enumerated/quote passes emit, computed from the
// fixture by the body's own helpers — imported so the reference tracks the body.
const references: Record<string, string> = {};

run();

async function run(): Promise<void> {
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await runGeneration(PLAN, deps);
  } catch (err) {
    process.stdout.write = realWrite;
    log(
      `  (runGeneration threw at the tail shape-assert, expected for the tiny fixture: ${
        err instanceof Error ? err.message.slice(0, 90) : String(err)
      })\n`,
    );
  } finally {
    process.stdout.write = realWrite;
  }

  buildReferences();

  for (const [label, ref] of Object.entries(references)) {
    const cap = captures.get(label);
    if (!cap) {
      ok(`${label} prompt captured`, false, "pass never fired");
      continue;
    }
    // Compare the TEMPLATE SKELETON: the prompt up to the `ARTICLE:` body, with
    // the interpolated counts (digits) + the research block + any enumerated
    // `- "…"` sentence list normalized out. This locks the prompt's PROSE
    // template (a drift there is a behavior change) while staying robust to the
    // article body mutating between passes (the real
    // convertPairedEmdashParentheticals / dropRepeatedClauses run un-stubbed) —
    // the body itself is data, not template, and is replayed byte-exactly by the
    // golden guard. The interpolated counts are separately asserted below.
    const capSkel = skeleton(cap.prompt);
    const refSkel = skeleton(ref);
    ok(
      `${label} prompt template byte-identical`,
      capSkel === refSkel,
      capSkel === refSkel ? undefined : firstDiff(capSkel, refSkel),
    );
    ok(
      `${label} conversion: user-only, temperature 0.3`,
      cap.system === undefined &&
        cap.model === MODEL &&
        cap.temperature === 0.3,
      `system=${String(cap.system)} model=${String(cap.model)} temp=${String(cap.temperature)}`,
    );
  }

  // Spot-check the EXACT interpolated counts survive (the template skeleton
  // normalizes digits, so assert the raw count strings appear in the prompts).
  const bandingCap = captures.get("banding-fix");
  ok(
    "banding-fix interpolates the vague count",
    !!bandingCap &&
      bandingCap.prompt.startsWith(
        `This article hand-waves about pay ${VAGUE_COUNT} times`,
      ),
    bandingCap?.prompt.slice(0, 60),
  );
  const tableCap = captures.get("table-fix");
  ok(
    "table-fix interpolates the dollar-figure count",
    !!tableCap &&
      tableCap.prompt.startsWith(
        `This article presents ${DOLLAR_FIGURES} distinct dollar figures`,
      ),
    tableCap?.prompt.slice(0, 60),
  );
  const attribCap = captures.get("attribution-fix");
  ok(
    "attribution-fix interpolates the tag count + cap",
    !!attribCap &&
      attribCap.prompt.startsWith(
        `This article uses inline attribution tags ("according to X", "per X") ${ATTRIB_COUNT} times; at most ${ATTRIB_TAG_MAX} may remain.`,
      ),
    attribCap?.prompt.slice(0, 90),
  );

  // ── enrichment split: neutralEnrichment shape + optionality ──────────────────
  {
    const neutral = neutralEnrichment<PipelineBoardCompany>();
    ok(
      "neutralEnrichment: empty site data",
      (await neutral.gatherSiteData("any", 6)).companies.length === 0 &&
        (await neutral.gatherSiteData("any", 6)).jobCount === 0,
      "expected empty PipelineSiteData",
    );
    ok(
      "neutralEnrichment: linkEntities is identity",
      neutral.linkEntities("body text", [{ name: "X", url: "/x" }]) ===
        "body text",
      "content must pass through unchanged",
    );
    const gate = await neutral.enforceLinkIntegrity("## H2\ncontent");
    ok(
      "neutralEnrichment: enforceLinkIntegrity passes content through",
      gate.content === "## H2\ncontent" && gate.stats === null,
      JSON.stringify(gate),
    );
    ok(
      "neutralEnrichment: withInternalLinks is identity on the article",
      (() => {
        const a = {
          title: "T",
          description: "D",
          category: "c",
          tags: [],
          keywords: [],
          content: "body",
        };
        return neutral.withInternalLinks(a, []) === a;
      })(),
      "article object must be returned as-is",
    );
  }

  // ── site-inventory empty-guard (Step 3d): the all-zeros site data this fixture
  // feeds must NOT inject a "verified" FIRST-PARTY SITE INVENTORY block into the
  // gates' ground truth. banding-fix's prompt embeds the body's `boardTruth`
  // (research region), so its capture proves the guard fired end-to-end.
  const bandingGround = captures.get("banding-fix");
  ok(
    "site-inventory empty-guard: no inventory block on all-zeros site data",
    !!bandingGround &&
      !bandingGround.prompt.includes("FIRST-PARTY SITE INVENTORY") &&
      !bandingGround.prompt.includes(" 0 open "),
    bandingGround?.prompt.slice(0, 120),
  );

  log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

function buildReferences(): void {
  // banding-fix
  references["banding-fix"] =
    `This article hand-waves about pay ${VAGUE_COUNT} times ("pays well", "competitive salaries", "strong wages", "six figures" and similar) instead of stating figures. Replace each vague pay phrase with a SPECIFIC figure or range from the RESEARCH below, correctly attributed — or cut the sentence if the research truly has no figure for that subject. At most THREE vague pay phrases may remain in the whole article. Change NOTHING else: every other word, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.\n\nRESEARCH (source figures from here — FIRST-PARTY and government blocks lead):\n${DATAGOD}\n${BOARD_TRUTH}\n${researchTail(60000)}\n\nARTICLE:\n${ARTICLE}`;

  // repetition-fix (pass 1, non-enumerated)
  references["repetition-fix"] =
    `Each of these phrases appears more than once in the article. Keep each one's STRONGEST occurrence and rework every other occurrence to reference the fact without repeating the phrasing (shorten it, use a pronoun, or fold it into context). Change NOTHING else: every other word, number, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.\n\nREPEATED PHRASES:\n${REPEAT_PHRASES.map((p) => `- "${p}"`).join("\n")}\n\nARTICLE:\n${ARTICLE}`;

  // The em-dash pass enumerates the dash-carrying sentences the body derives
  // from the article via splitSentences (imported from ./text — the SAME parser
  // the body uses), so this reference tracks the body's exact list.
  const offendingEmdash = splitSentences(
    ARTICLE.split("\n")
      .filter((line) => !/^\s*\|/.test(line))
      .join("\n"),
  ).filter((s) => s.includes("—"));
  references["emdash-fix"] =
    `This article uses the em-dash (—) ${EMDASH_COUNT} times; at most ${EMDASH_CAP} may remain. These are the exact sentences carrying them — rewrite ONLY these sentences, converting excess em-dashes into a comma, period, parentheses, or a restructured sentence, keeping only the ${EMDASH_CAP} strongest across the whole article:\n${offendingEmdash
      .map((s) => `- "${s}"`)
      .join(
        "\n",
      )}\n\nEvery other sentence stays exactly as written: every other word, number, link, and heading unchanged. Output ONLY the full corrected markdown article.\n\nARTICLE:\n${ARTICLE}`;

  references["table-fix"] =
    `This article presents ${DOLLAR_FIGURES} distinct dollar figures entirely in prose. Convert the COMPARABLE ones (salaries by role, ranges by source, market sizes by firm) into ONE compact markdown table placed at the most natural spot, and trim the prose that merely restates the tabled numbers. Keep non-comparable figures in prose. Change nothing else — every link, heading, and remaining sentence stays exactly as written. Output ONLY the full corrected markdown article.\n\nARTICLE:\n${ARTICLE}`;

  // attribution-fix pass 1 (no enumerated tail).
  references["attribution-fix"] =
    `This article uses inline attribution tags ("according to X", "per X") ${ATTRIB_COUNT} times; at most ${ATTRIB_TAG_MAX} may remain. Rewrite ONLY the excess instances into varied attribution — "X reported", "X's data shows", "X found", a possessive ("X's figures put…"), or state the fact and cite the source in a nearby sentence. Change NOTHING else: every other word, number, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.\n\nARTICLE:\n${ARTICLE}`;

  // emdash-decluster (dep-rigged CLUSTERED).
  references["emdash-decluster"] =
    `In this article, ${CLUSTERED} SENTENCES contain THREE OR MORE em-dashes (—) each — a run-on dash cadence. Rewrite ONLY those sentences so each keeps at most one or two em-dashes (a bracketed parenthetical "X — appositive — Y" is fine; convert the rest to commas, parentheses, or restructured sentences). Every other sentence stays exactly as written; preserve all links, numbers, and headings. Output ONLY the full corrected markdown article.\n\nARTICLE:\n${ARTICLE}`;
}

function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `diff@${i}: got …${JSON.stringify(a.slice(Math.max(0, i - 30), i + 25))} want …${JSON.stringify(b.slice(Math.max(0, i - 30), i + 25))}`;
    }
  }
  return `length ${a.length} vs ${b.length}`;
}

/** Reduce a surgical-fix prompt to its TEMPLATE skeleton: keep everything up to
 *  the `ARTICLE:` body (drop the mutation-sensitive article), then normalize the
 *  interpolated parts — digit-runs → `#`, the research block body → `<R>`, and
 *  each enumerated `- "…"` sentence/phrase line → `- "<S>"`. Two prompts with
 *  the same skeleton share the exact prose template. */
function skeleton(prompt: string): string {
  // Drop the article body.
  const head = prompt.split("\n\nARTICLE:\n")[0];
  return (
    head
      // research block: from the `lead):\n` marker to end-of-head → placeholder.
      .replace(/lead\):\n[\s\S]*$/, "lead):\n<R>")
      // enumerated list lines (- "…") → a single placeholder form.
      .replace(/^- ".*"$/gm, '- "<S>"')
      // any remaining digit run → '#'.
      .replace(/\d+/g, "#")
  );
}
