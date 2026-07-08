/**
 * Checks for section-writer.ts — run: npx tsx section-writer.checks.ts
 *
 * writeAllSections takes an injected per-section writer + error logger, so
 * order-preservation and the failed-section→placeholder behavior are testable
 * without the network. The real research+write (writeOneSection) is
 * integration-verified in the dry-run.
 */
import {
  sectionPlaceholder,
  writeAllSections,
  writeOneSection,
  type SectionResult,
  type SectionWriterDeps,
} from "./section-writer";
import { themeOf, type Plan } from "./planning";

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

const plan: Plan = {
  title: "The Defense-Tech Talent War",
  angle: "why primes are losing engineers to startups",
  sections: [
    { heading: "First", intent: "set the stage", queries: [] },
    { heading: "Second", intent: "the pay gap", queries: [] },
    { heading: "Third", intent: "the mission pull", queries: [] },
  ],
};

async function main(): Promise<void> {
  // Stub writer: returns markdown + research per section, but index 1 throws.
  const stub = async (p: Plan, i: number): Promise<SectionResult> => {
    if (i === 1) throw new Error("simulated section failure");
    return {
      markdown: `## ${p.sections[i].heading}\n\nbody ${i}`,
      research: `research ${i}`,
    };
  };

  // Stub error logger: the failed-section path must still produce a placeholder
  // (the assertion below), so a no-op logger faithfully exercises that branch.
  const onError = (): void => {};

  // 3 = the engine's stable BLOG_SECTION_CONCURRENCY default (now a parameter).
  const out = await writeAllSections(plan, stub, onError, 3);
  eq("one markdown per section", out.markdowns.length, 3);
  eq("order preserved (0)", out.markdowns[0], "## First\n\nbody 0");
  eq("order preserved (2)", out.markdowns[2], "## Third\n\nbody 2");
  eq(
    "failed section → placeholder (not a crash)",
    out.markdowns[1],
    sectionPlaceholder("Second"),
  );
  eq(
    "placeholder starts at the section H2",
    out.markdowns[1]?.startsWith("## Second"),
    true,
  );
  eq(
    "research pooled, failed section excluded",
    out.research.includes("research 0") &&
      out.research.includes("research 2") &&
      !out.research.includes("research 1"),
    true,
  );

  // Part A (2026-07): long-context prompt mechanics — the task must be RESTATED
  // after the research payload (lost-in-the-middle: end-position attention wins).
  // No prompt capture existed for writeSection: drive writeOneSection with a
  // capturing llm stub (mirrors gates.checks.ts's capture pattern).
  let capturedSectionPrompt = "";
  const captureDeps: SectionWriterDeps = {
    llm: {
      complete: async (args) => {
        capturedSectionPrompt = args.prompt;
        return "## First\n\nbody";
      },
      completeStructured: async () => {
        throw new Error("completeStructured is not used by writeSection");
      },
    },
    gatherResearch: async () => ({ block: "research block" }),
    searchSnippets: async () => [],
    systemPrompt: () => "system prompt",
    withRetry: async <T>(_label: string, fn: () => Promise<T>): Promise<T> =>
      fn(),
    onError: () => {},
    model: "test-model",
    sectionSnippets: 4,
    sectionConcurrency: 3,
    brandName: "TestBrand",
  };
  await writeOneSection(plan, 0, "- Board: 42 open widget roles", captureDeps);
  ok(
    "section prompt restates the task AFTER the research block",
    // Anchor the payload on its FIRST occurrence (the block header): the
    // restated rules deliberately echo "FIRST-PARTY BOARD DATA", so a
    // lastIndexOf-vs-lastIndexOf comparison would self-defeat.
    capturedSectionPrompt.lastIndexOf("YOUR TASK, RESTATED") >
      capturedSectionPrompt.indexOf("FIRST-PARTY BOARD DATA"),
  );
  ok(
    "section prompt carries the recency rule",
    capturedSectionPrompt.includes("prefer the NEWEST dated source"),
  );

  // Part B (2026-07): the MAIN THEME anchor opens every section prompt (themeOf
  // falls back to "title — angle" for plans without a themeStatement, so the
  // anchor is always present).
  ok(
    "section prompt opens with the MAIN THEME anchor",
    capturedSectionPrompt.startsWith("MAIN THEME"),
  );
  ok(
    "section restatement block repeats the theme rule",
    capturedSectionPrompt.includes("Serve the MAIN THEME above") &&
      capturedSectionPrompt.indexOf("Serve the MAIN THEME above") >
        capturedSectionPrompt.lastIndexOf("YOUR TASK, RESTATED"),
  );

  // Part C (2026-07): extractive research digests + thin-section backfill.
  //
  // 1) ABSENT digest deps (the capture run above supplied none): the prompt
  //    must be BYTE-IDENTICAL to the pre-digest legacy shape. Locked verbatim
  //    (the pipeline.checks.ts reference pattern) so the digest wiring can
  //    never drift the legacy prompt, plus the plan's substring form.
  const legacyReference = `MAIN THEME — every paragraph must serve this: ${themeOf(plan)}

You are writing ONE section of a larger article. Here is the whole plan so your section fits the arc and does NOT repeat what other sections cover.

ARTICLE: "${plan.title}"
ANGLE: ${plan.angle}
FULL SECTION PLAN:
${plan.sections.map((s, i) => `${i + 1}. ${s.heading} — ${s.intent}`).join("\n")}

>>> You are writing section 1: "First" <<<
This section's job: set the stage

Write ONLY this section's markdown. Start with its H2 heading "## First" — no H1, no other sections, no preamble or sign-off. Ground every figure, quote, name, and relationship in the RESEARCH below; never invent specifics. Where the research is thin, write qualitatively rather than fabricating. For any TestBrand references use relative-path links only — never a promotional line or CTA (the system appends the CTA after publication). Target 350–550 words of body prose — develop the argument fully with grounded specifics and analysis, never filler.

RESEARCH FOR THIS SECTION:
research block\n\nFIRST-PARTY BOARD DATA (TestBrand's own live data, ingested directly at the source — stronger than any third-party count OR third-party figure). For any figure below that a web source also reports second-hand, PREFER this first-party board figure over the web-scraped one, and cite the specific board item by name (it links to the on-site listing). For other facts, cite one figure only when directly relevant — never force it:\n- Board: 42 open widget roles\n\n=== YOUR TASK, RESTATED (the payload above is reference material; THIS is the job) ===\nWrite ONLY section 1: "First" — set the stage\nRules: ground every figure in the RESEARCH or FIRST-PARTY BOARD DATA above (first-party preferred); prefer the NEWEST dated source when sources conflict and date-qualify anything older than a few weeks ("as of <month>…"); never invent people, quotes, scenes, or numbers; do not repeat what other planned sections cover; output ONLY this section's markdown, starting at its H2.\nLength: 350–550 words.\nServe the MAIN THEME above; if your research contradicts it, write what the research supports and flag the tension in one sentence.\nLEAD CRAFT (this is the article's opening section): the first paragraph must open a question the reader has to answer by continuing — strip it of numbers, company lists, and qualifiers (they belong in paragraph 2+); if the development itself is hard news, lead with the news plainly; never write a billboard/"what follows will amaze you" opening.`;
  eq(
    "absent digest deps → prompt byte-identical to the legacy reference",
    capturedSectionPrompt,
    legacyReference,
  );
  ok(
    // Plan-spec form. (The plan draft asserted includes("RESEARCH:"), a
    // substring the byte-locked legacy prompt never contained — its label is
    // "RESEARCH FOR THIS SECTION:"; asserted via the real label instead.)
    "absent digest deps → prompt identical to legacy shape",
    capturedSectionPrompt.includes("RESEARCH FOR THIS SECTION:") &&
      !capturedSectionPrompt.includes("DIGEST"),
  );

  // 2) Digest-active composition: MAIN THEME → plan block → GENERAL digest
  //    (background) → THIS SECTION'S digest (primary) → board block →
  //    restatement. The RAW block still pools into SectionResult.research
  //    (the gate chain's ground truth is never a digest).
  let capturedDigestedPrompt = "";
  const digestActiveDeps: SectionWriterDeps = {
    ...captureDeps,
    llm: {
      complete: async (args) => {
        capturedDigestedPrompt = args.prompt;
        return "## First\n\nbody";
      },
      completeStructured: async () => {
        throw new Error("completeStructured is not used by writeSection");
      },
    },
    gatherResearch: async () => ({ block: "raw research block" }),
    generalDigest: "## SCOPE\n- general digest bullet",
    digestSection: async (raw, label) =>
      `## SCOPE\n- digest of ${label} (${raw.length} chars)`,
  };
  const digestedOut = await writeOneSection(
    plan,
    0,
    "- Board: 42 open widget roles",
    digestActiveDeps,
  );
  ok(
    "general digest labeled background, section digest labeled primary",
    capturedDigestedPrompt.indexOf("GENERAL RESEARCH DIGEST") >= 0 &&
      capturedDigestedPrompt.indexOf("GENERAL RESEARCH DIGEST") <
        capturedDigestedPrompt.indexOf("THIS SECTION'S RESEARCH DIGEST") &&
      capturedDigestedPrompt.includes("cite only when directly relevant"),
  );
  ok(
    "digest-active order: theme → plan → general → section digest → board → restatement",
    capturedDigestedPrompt.startsWith("MAIN THEME") &&
      capturedDigestedPrompt.indexOf("FULL SECTION PLAN:") <
        capturedDigestedPrompt.indexOf("GENERAL RESEARCH DIGEST") &&
      capturedDigestedPrompt.indexOf("THIS SECTION'S RESEARCH DIGEST") <
        capturedDigestedPrompt.indexOf("FIRST-PARTY BOARD DATA") &&
      capturedDigestedPrompt.indexOf("FIRST-PARTY BOARD DATA") <
        capturedDigestedPrompt.lastIndexOf("YOUR TASK, RESTATED"),
  );
  ok(
    "digest-active prompt grounds on the digests; raw block pools untouched",
    capturedDigestedPrompt.includes("- digest of First (18 chars)") &&
      !capturedDigestedPrompt.includes("RESEARCH FOR THIS SECTION:") &&
      !capturedDigestedPrompt.includes("raw research block") &&
      digestedOut.research === "raw research block",
  );

  // 3) Thin-section backfill: an EMPTY gather calls retryThin BEFORE the
  //    qualitative fallback; its research grounds the prompt AND pools.
  // Capture-object (not a bare let): TS's CFA doesn't track closure
  // assignments, so a boolean let stays narrowed to `false` at the assertion.
  const retryThinCalled = { v: false };
  let capturedThinPrompt = "";
  const thinDeps: SectionWriterDeps = {
    ...captureDeps,
    llm: {
      complete: async (args) => {
        capturedThinPrompt = args.prompt;
        return "## First\n\nbody";
      },
      completeStructured: async () => {
        throw new Error("completeStructured is not used by writeSection");
      },
    },
    gatherResearch: async () => ({ block: "" }),
    retryThin: async (section) => {
      retryThinCalled.v = true;
      return `### Source (retry): ${section.heading} backfill`;
    },
  };
  const thinOut = await writeOneSection(plan, 0, "", thinDeps);
  ok(
    "thin section calls retryThin before the qualitative fallback",
    retryThinCalled.v === true,
  );
  ok(
    "retryThin research grounds the prompt (no qualitative fallback) and pools",
    capturedThinPrompt.includes("### Source (retry): First backfill") &&
      !capturedThinPrompt.includes("(no external research returned") &&
      thinOut.research.includes("### Source (retry): First backfill"),
  );
  const retryThinCalledOnRich = { v: false };
  await writeOneSection(plan, 0, "", {
    ...captureDeps,
    llm: {
      complete: async () => "## First\n\nbody",
      completeStructured: async () => {
        throw new Error("completeStructured is not used by writeSection");
      },
    },
    gatherResearch: async () => ({ block: "rich research" }),
    retryThin: async () => {
      retryThinCalledOnRich.v = true;
      return "never used";
    },
  });
  ok(
    "retryThin NOT called when the gather returned research",
    retryThinCalledOnRich.v === false,
  );

  process.stdout.write(
    failed === 0
      ? `\nALL ${passed} checks passed\n`
      : `\n${failed} FAILED, ${passed} passed\n`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
