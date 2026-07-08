/** Checks for digest.ts — the extractive six-box digest builder.
 * Run: npx tsx digest.checks.ts */
import { buildDigest } from "./digest";

let f = 0,
  p = 0;
const ok = (n: string, c: boolean): void => {
  if (c) {
    p++;
  } else {
    f++;
  }
  process.stdout.write(`${c ? "PASS" : "FAIL"} ${n}\n`);
};

let captured = "";
const deps = {
  llm: {
    complete: async (a: { prompt: string }) => (
      (captured = a.prompt),
      '## SCOPE\n- "2,045 roles" — https://x.com (2026-07-01)'
    ),
  },
  model: "m",
  withRetry: async <T>(_l: string, fn: () => Promise<T>) => fn(),
};
const out = await buildDigest(
  "### Source 1 [tier 1] (2026-07-01): T\nBody with 2,045 roles.",
  "general",
  deps as never,
);
ok(
  "digest prompt demands verbatim extraction",
  captured.includes("VERBATIM") && captured.includes("never paraphrase"),
);
ok(
  "digest prompt indexes into the six boxes",
  ["HISTORY", "SCOPE", "REASONS", "IMPACTS", "COUNTERMOVES", "FUTURES"].every(
    (b) => captured.includes(b),
  ),
);
ok(
  "digest prompt restates task at the end",
  captured.lastIndexOf("YOUR TASK, RESTATED") >
    captured.lastIndexOf("Body with"),
);
ok("digest returns the model output", out.includes("2,045 roles"));

process.stdout.write(f ? `\n${f} FAILED, ${p} passed\n` : `\nALL ${p} passed\n`);
if (f) process.exit(1);
