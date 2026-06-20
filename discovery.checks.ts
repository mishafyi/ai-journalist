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
import { titleCollidesLexically, buildSignalText } from "./discovery";
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

process.stdout.write(
  failed === 0
    ? `\nALL ${passed} checks passed\n`
    : `\n${failed} FAILED, ${passed} passed\n`,
);
if (failed > 0) process.exit(1);
