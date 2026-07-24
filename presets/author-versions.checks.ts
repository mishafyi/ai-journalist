/**
 * author-versions.checks.ts — checkAuthorVersionContract mechanics and
 * composeAuthorVersion's retry-until-contract loop. Orchestration coverage
 * lives in news-desk.checks.ts (one take per story since 2026-07-24).
 *
 * Run: npx tsx presets/author-versions.checks.ts
 */
import { BOTTOM_LINE_MARKER, DISANALOGY_MARKER, NO_PARALLEL_PHRASE } from "../gates";
import type { LlmClient } from "../ports";
import { checkAuthorVersionContract, composeAuthorVersion, PERSONAS } from "./news-desk";

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
  `## The rate that broke the room's nerve`,
  `Wire reports that the central bank raised its policy rate by 50 basis points to a twenty-year high, and per Beacon, markets fell 2 percent on the announcement. "We will stay the course," the chair said.`,
  `## A lender of last resort, ninety years early`,
  `The Panic of 1907 is the closest rhyme to this squeeze: a systemic halt ended only by a lender of last resort, and the lesson has not aged a day. ${FILLER.repeat(12)}`,
  `${DISANALOGY_MARKER} Unlike 1907, today's backstop is institutional — no private financier had to improvise the rescue. ${FILLER.repeat(8)}`,
  `${BOTTOM_LINE_MARKER} Central banks will blink first, exactly as they always have since 1907, and savers will pay for the blink.`,
].join("\n\n");

function contractChecks(): void {
  const args = { outletNames: ["Wire", "Beacon", "Teaser Daily"], parallelEvent: "Panic of 1907", wordCap: 600, writerName: "The Historian" };
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

  // Chapters are required and their titles must be original (operator,
  // 2026-07-24): "## Analysis — The Historian" is exactly what we retired.
  const noHeads = checkAuthorVersionContract(GOOD_BODY.replace(/^## .*$/gm, "").trim(), args);
  ok("contract: a column with no chapter headings fails",
    !noHeads.ok && noHeads.failures.some((f) => f.includes("at least 2 chapter headings")),
    noHeads.failures.join(" | "));

  const generic = checkAuthorVersionContract(
    GOOD_BODY.replace("## The rate that broke the room's nerve", "## Analysis"), args);
  ok("contract: a generic label heading fails",
    !generic.ok && generic.failures.some((f) => f.includes("generic label")), generic.failures.join(" | "));

  const named = checkAuthorVersionContract(
    GOOD_BODY.replace("## The rate that broke the room's nerve", "## Analysis — The Historian"), args);
  ok("contract: 'Analysis — <writer>' fails (generic AND names the columnist)",
    !named.ok && named.failures.some((f) => f.includes("generic label") || f.includes("names the columnist")),
    named.failures.join(" | "));

  const thinHead = checkAuthorVersionContract(
    GOOD_BODY.replace("## The rate that broke the room's nerve", "## Rates rise"), args);
  ok("contract: a two-word heading is too thin to be a chapter title",
    !thinHead.ok && thinHead.failures.some((f) => f.includes("too thin")), thinHead.failures.join(" | "));
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
async function main(): Promise<void> {
  contractChecks();
  await composeChecks();
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
