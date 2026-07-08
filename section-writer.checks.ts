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
import { type Plan } from "./planning";

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
