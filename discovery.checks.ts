/**
 * Checks for discovery.ts — run: npx tsx discovery.checks.ts
 *
 * Covers:
 *  - the PURE anti-repetition decision (titleCollidesLexically), and
 *  - the BYTE-LOCK that severs the engine↔host data-gathering coupling: discovery
 *    now reads the domain-agnostic `DiscoverySignal` via `buildSignalText`,
 *    while the host adapter folds BoardSignal+JobsCorpus into it. The
 *    golden guard replays LLM *outputs* by call-order, so it does NOT catch a
 *    changed query-gen PROMPT. This check does: it reconstructs the OLD
 *    `buildJobsSignal(board, corpus)` string verbatim (the byte reference),
 *    maps the same fixture through a replica of the adapter's `boardToSignal`,
 *    runs the engine's `buildSignalText`, and asserts the two prompts are
 *    byte-identical — so no future change to either side can silently drift the
 *    prompt the discovery LLM sees.
 *
 * The orchestration (generateQueries → broadResearch → pickStoryAndPlan →
 * re-pick) is integration-verified in the Task 10 dry-run. Importing this module
 * loads the engine's real trigram/entity helpers (deterministic, no network).
 */
import {
  titleCollidesLexically,
  buildSignalText,
  discoverStory,
  type DiscoveryDeps,
} from "./discovery";
import { type DiscoverySignal, type SignalItem } from "./ports";

// The engine's stable trigram cutoff default (adapter binds BLOG_DEDUP_THRESHOLD
// → 0.37). The threshold is now a parameter; this check pins the default.
const DEDUP_THRESHOLD = 0.37;

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(
      `FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n`,
    );
  }
}
function ok(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${name}\n`);
  }
}

// Clean: unrelated subject + no shared entity → not a collision.
eq(
  "clean title accepted",
  titleCollidesLexically(
    "Quantum Sensors Reach the Battlefield",
    ["AI hiring trends at robotics startups"],
    DEDUP_THRESHOLD,
  ),
  false,
);

// No covered history → never a collision.
eq(
  "empty covered accepted",
  titleCollidesLexically("Anything goes here", [], DEDUP_THRESHOLD),
  false,
);

// Trigram near-dup (same words, different case/wording) → collision.
eq(
  "trigram near-dup flagged",
  titleCollidesLexically(
    "AI tokens that compensate engineers",
    ["AI Tokens That Compensate Engineers"],
    DEDUP_THRESHOLD,
  ),
  true,
);

// Entity + money overlap at LOW trigram (the R6C4 class) → collision via
// sharesEntityEvent even though the wording diverges.
eq(
  "entity+money dup flagged (low trigram)",
  titleCollidesLexically(
    "Impulse Space Raises $500M Series C",
    ["Why Impulse's $500M Round Changes the Launch Market"],
    DEDUP_THRESHOLD,
  ),
  true,
);

// Same company but DIFFERENT money/no money → not flagged by the entity gate.
eq(
  "same company, no shared money → not flagged",
  titleCollidesLexically(
    "Impulse Space Opens a Texas Factory",
    ["Why Impulse's $500M Round Changes the Launch Market"],
    DEDUP_THRESHOLD,
  ),
  false,
);

// ───────────────────────────────────────────────────────────────────────────
// PROMPT BYTE-LOCK — discovery's query-gen prompt body must be unchanged by the
// BoardSignal → DiscoverySignal carve. (See header: the golden guard can't see
// prompt changes — it replays outputs by call-order.)
// ───────────────────────────────────────────────────────────────────────────

// The OLD `buildJobsSignal` shapes — kept local to this check (the engine no
// longer imports them). A representative fixture: one company WITH locations +
// multiple titles, one WITHOUT locations (exercises the conditional ` — locs`),
// non-trivial aggregate stats, top-locations, and a raw-postings excerpt.
interface RefBoardCompany {
  name: string;
  industry: string;
  count: number;
  titles: string[];
  locations: string[];
}
interface RefBoard {
  windowHours: number;
  totalJobs: number;
  companyCount: number;
  topCompanies: RefBoardCompany[];
  topLocations: string[];
}
interface RefCorpus {
  text: string;
}

// The byte default the engine used pre-carve (BLOG_JOBS_SIGNAL_CHARS ?? "8000");
// the adapter now owns it. Fixture text stays well under it (slice is a no-op),
// but both sides apply the identical slice+trim so the lock is exact.
const JOBS_SIGNAL_CHARS = Number(process.env.BLOG_JOBS_SIGNAL_CHARS ?? "8000");

const fixtureBoard: RefBoard = {
  windowHours: 24,
  totalJobs: 137,
  companyCount: 19,
  topCompanies: [
    {
      name: "Blue Origin",
      industry: "Aerospace",
      count: 116,
      titles: [
        "Sr. Manager, Business Resilience",
        "Administrative Coordinator III",
        "Propulsion Test Engineer",
      ],
      locations: ["Merritt Island, FL", "Kent, WA"],
    },
    {
      name: "Anduril",
      industry: "Defense",
      count: 12,
      titles: ["Mission Software Engineer"],
      locations: [], // no locations → the ` — locs` suffix must be omitted
    },
  ],
  topLocations: ["Merritt Island, FL (40)", "Kent, WA (22)"],
};
const fixtureCorpus: RefCorpus = {
  text: "Blue Origin | Aerospace | Propulsion Test Engineer | Merritt Island, FL | $145K-$203K\nReusable launch hardware...\n\nAnduril | Defense | Mission Software Engineer | Costa Mesa, CA\nAutonomy stack...",
};

// OLD prompt — `buildJobsSignal(board, corpus)` reproduced verbatim. This is the
// byte reference the carve must preserve.
function oldBuildJobsSignal(board: RefBoard, corpus: RefCorpus): string {
  const companies =
    board.topCompanies
      .map(
        (c) =>
          `- ${c.name} (${c.industry}): ${c.count} new role(s) — ${c.titles.join(
            ", ",
          )}${c.locations.length ? ` — ${c.locations.join("; ")}` : ""}`,
      )
      .join("\n") || "(none)";
  const excerpt = corpus.text.slice(0, JOBS_SIGNAL_CHARS).trim();
  return `Window: last ${board.windowHours}h. ${board.totalJobs} new roles across ${board.companyCount} companies.

TOP HIRING COMPANIES:
${companies}

TOP LOCATIONS: ${board.topLocations.join(", ") || "(n/a)"}

SAMPLE POSTINGS (raw, truncated):
${excerpt}`;
}

// ADAPTER — `boardToSignal(board, corpus)` reproduced (the host adapter is
// host-bound and runs main() on import, so it can't be imported here; this replica
// mirrors it 1:1 and the check locks engine(replica) === old-prompt).
function refBoardToSignal(board: RefBoard, corpus: RefCorpus): DiscoverySignal {
  const items: SignalItem[] = board.topCompanies.map((c) => ({
    title: c.name,
    summary: `${c.name} (${c.industry}): ${c.count} new role(s) — ${c.titles.join(
      ", ",
    )}${c.locations.length ? ` — ${c.locations.join("; ")}` : ""}`,
    entities: [c.name],
    weight: c.count,
    meta: { industry: c.industry, titles: c.titles, locations: c.locations },
  }));
  return {
    items,
    framing: `Window: last ${board.windowHours}h. ${board.totalJobs} new roles across ${board.companyCount} companies.\n\nTOP HIRING COMPANIES:`,
    corpus: `TOP LOCATIONS: ${board.topLocations.join(", ") || "(n/a)"}\n\nSAMPLE POSTINGS (raw, truncated):\n${corpus.text.slice(0, JOBS_SIGNAL_CHARS).trim()}`,
  };
}

const oldPrompt = oldBuildJobsSignal(fixtureBoard, fixtureCorpus);
const newPrompt = buildSignalText(
  refBoardToSignal(fixtureBoard, fixtureCorpus),
);
eq("query-gen prompt byte-identical (adapter → engine)", newPrompt, oldPrompt);

// Empty board → both render the `(none)` company list identically.
const emptyBoard: RefBoard = {
  windowHours: 168,
  totalJobs: 0,
  companyCount: 0,
  topCompanies: [],
  topLocations: [],
};
const emptyCorpus: RefCorpus = { text: "" };
eq(
  "empty-board prompt byte-identical ((none) + (n/a))",
  buildSignalText(refBoardToSignal(emptyBoard, emptyCorpus)),
  oldBuildJobsSignal(emptyBoard, emptyCorpus),
);

// ───────────────────────────────────────────────────────────────────────────
// Part A (2026-07): six-box query coverage + cause-and-effect fencing. The
// discovery prompts (query-gen + story-plan) had no capture: drive discoverStory
// with a capturing llm stub (schemaName tells the two passes apart) + fixture
// deps, then assert the new prompt lines. buildSignalText stays byte-locked
// above — these edits go around the signal formatting, never through it.
// ───────────────────────────────────────────────────────────────────────────

let capturedQueryGenPrompt = "";
let capturedStoryPlanPrompt = "";

const captureDeps: DiscoveryDeps = {
  // Historical identity values — the locked reference prompts below were
  // written when these were baked into the engine; they now thread via deps.
  desk: "a frontier-tech hiring publication (space, defense, robotics, AI, energy, biotech)",
  signalLabel:
    "our LIVE job-board hiring signal — who is hiring right now, for what, and where",
  signalHeading: "HIRING SIGNAL",
  audience:
    "engineers and operators in space / defense / robotics / AI / energy / biotech",
  categories: [
    "robotics",
    "artificial-intelligence",
    "aerospace-engineering",
    "defense",
    "energy",
    "biotech",
    "frontier",
  ],
  llm: {
    complete: async () => {
      throw new Error("free-text complete is not used by discovery");
    },
    completeStructured: async (args) => {
      const prompt =
        args.messages.find((m) => m.role === "user")?.content ?? "";
      if (args.schemaName === "discovery_queries") {
        capturedQueryGenPrompt = prompt;
        return args.schema.parse({
          queries: ["widget factory expansion"],
          companies: [], // no companies → no RSS fetch (network-free)
        });
      }
      capturedStoryPlanPrompt = prompt;
      return args.schema.parse({
        title: "Acme Widgets Ships a Faster Widget",
        angle: "why the widget market just moved",
        category: "robotics",
        searchSeed: "widget jobs",
        sections: [
          {
            heading: "The Move",
            intent: "establish the development",
            queries: ["acme widgets news"],
          },
        ],
      });
    },
  },
  gatherSignal: async () => ({
    items: [
      {
        title: "Acme Widgets",
        summary: "Acme Widgets (Widgets): 3 new role(s) — Widget Engineer",
        entities: ["Acme Widgets"],
      },
    ],
  }),
  searchSnippets: async () => ["snippet about the widget market"],
  gatherCoveredTopics: async () => [],
  embedDedupSurvivors: async () => null,
  withRetry: async <T>(_label: string, fn: () => Promise<T>): Promise<T> =>
    fn(),
  getRunId: () => "run_checks",
  onEvent: async () => {},
  onError: () => {},
  model: "test-model",
  dedupThreshold: DEDUP_THRESHOLD,
  embedDedupSim: 0.86,
  discoveryQueries: 15,
  newsCompanies: 12,
  maxSections: 7,
  sectionQueries: 3,
  researchConcurrency: 4,
  snippetsPerQuery: 5,
  rssPerCompany: 5,
};

discoverStory(captureDeps)
  .then(() => {
    ok(
      "query-gen spreads queries across the six story boxes",
      capturedQueryGenPrompt.includes("history") &&
        capturedQueryGenPrompt.includes("countermoves") &&
        capturedQueryGenPrompt.includes("futures"),
    );
    ok(
      "story-plan demands an action map and a fence",
      capturedStoryPlanPrompt.includes("cause-and-effect") &&
        capturedStoryPlanPrompt.includes("explicitly OUT of scope"),
    );
    ok(
      "query-gen teaches the five ideation moves",
      capturedQueryGenPrompt.includes("EXTRAPOLATE") &&
        capturedQueryGenPrompt.includes("SWITCH VIEWPOINT"),
    );
    ok(
      "story-plan picks approach + block order",
      capturedStoryPlanPrompt.includes("APPROACH") &&
        capturedStoryPlanPrompt.includes("stresses most"),
    );
    // Part B (2026-07): the JSON spec asks for a themeStatement. Both plan
    // paths (pooled-research discoverStory AND the seeded planForTopic) share
    // this one pickStoryAndPlan prompt, so one lock covers both.
    ok(
      "story-plan JSON spec asks for a themeStatement",
      capturedStoryPlanPrompt.includes('"themeStatement"') &&
        capturedStoryPlanPrompt.includes("no details, no numbers"),
    );

    process.stdout.write(
      failed === 0
        ? `\nALL ${passed} checks passed\n`
        : `\n${failed} FAILED, ${passed} passed\n`,
    );
    if (failed > 0) process.exit(1);
  })
  .catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
