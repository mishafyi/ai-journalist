/**
 * Checks for assembly.ts — run: npx tsx assembly.checks.ts
 *
 * Covers the pure assemble(). tieTogether is the existing runEdit/runFinalEdit
 * LLM passes (integration-verified in the dry-run).
 */
import { assemble } from "./assembly";
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

const plan: Plan = {
  title: "My Headline",
  angle: "the throughline",
  sections: [
    { heading: "Alpha", intent: "i", queries: [] },
    { heading: "Beta", intent: "i", queries: [] },
  ],
};

const out = assemble(plan, ["## Alpha\n\nbody a", "## Beta\n\nbody b"]);
eq("starts with the H1 title", out.startsWith("# My Headline\n\n"), true);
eq(
  "sections stitched in order",
  out,
  "# My Headline\n\n## Alpha\n\nbody a\n\n## Beta\n\nbody b",
);
eq(
  "first section precedes second",
  out.indexOf("## Alpha") < out.indexOf("## Beta"),
  true,
);
eq("exactly one H1", (out.match(/^# /gm) ?? []).length, 1);

process.stdout.write(
  failed === 0
    ? `\nALL ${passed} checks passed\n`
    : `\n${failed} FAILED, ${passed} passed\n`,
);
if (failed > 0) process.exit(1);
