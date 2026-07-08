/** Checks for digest.ts — the extractive six-box digest builder + the
 * theme-recast checkpoint. Run: npx tsx digest.checks.ts */
import { buildDigest, recastTheme } from "./digest";
import { computeGateWarnings } from "./gate";
import { createRunContext } from "./run-context";

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

// ── C4: recastTheme — judge the planned theme against the organized evidence.
// Staleness/kill warnings must flow through the EXISTING gate-warnings channel
// (ctx.telemetry.article flags → computeGateWarnings), so the checks read them
// back through computeGateWarnings itself.
const DIGEST = '## SCOPE\n- "2,045 roles" — https://x.com (2026-07-01)';
let recastPrompt = "";
const recastDeps = (canned: unknown, extra: object): never =>
  ({
    llm: {
      complete: async () => "",
      completeStructured: async (a: {
        messages: { content: string }[];
        schema: { parse: (v: unknown) => unknown };
      }) => ((recastPrompt = a.messages[0].content), a.schema.parse(canned)),
    },
    model: "m",
    withRetry: async <T>(_l: string, fn: () => Promise<T>) => fn(),
    ...extra,
  }) as never;

// keep/adjust path — prompt shape + returned theme + fresh date is quiet.
{
  const ctx = createRunContext("run_c4");
  const res = await recastTheme(
    "Old theme — angle",
    DIGEST,
    recastDeps(
      {
        verdict: "adjust",
        theme: "New theme.",
        note: "n",
        newestSourceDate: "2026-07-01",
      },
      { ctx, nowIso: "2026-07-05T00:00:00.000Z", maxStoryAgeDays: 14 },
    ),
  );
  ok(
    "recast prompt carries the planned theme",
    recastPrompt.includes('MAIN THEME: "Old theme — angle"'),
  );
  ok("recast prompt embeds the digest", recastPrompt.includes("2,045 roles"));
  ok(
    "recast prompt restates the task AFTER the digest",
    recastPrompt.lastIndexOf("YOUR TASK, RESTATED") >
      recastPrompt.lastIndexOf("2,045 roles"),
  );
  ok(
    "recast prompt explains the fields",
    recastPrompt.includes('"kill" means the evidence cannot support') &&
      recastPrompt.includes("newestSourceDate") &&
      recastPrompt.includes("unchanged if verdict is keep"),
  );
  ok(
    "adjust verdict returns the recast theme",
    res.verdict === "adjust" && res.theme === "New theme.",
  );
  ok(
    "fresh date → no stale warning",
    computeGateWarnings(ctx.telemetry.article ?? {}, 1500).length === 0,
  );
}

// stale date → the EXACT warning, via the gate-warnings channel; the 14-day
// window is the engine-side default (no maxStoryAgeDays passed).
{
  const ctx = createRunContext("run_c4_stale");
  await recastTheme(
    "T",
    DIGEST,
    recastDeps(
      { verdict: "keep", theme: "T", newestSourceDate: "2026-06-01" },
      { ctx, nowIso: "2026-07-07T00:00:00.000Z" },
    ),
  );
  ok(
    "stale date → exact warning through computeGateWarnings (default max 14)",
    computeGateWarnings(ctx.telemetry.article ?? {}, 1500).includes(
      "stale-story: newest dated source 2026-06-01 is 36d old (max 14)",
    ),
  );
}

// null date → the gate never fires blind.
{
  const ctx = createRunContext("run_c4_null");
  await recastTheme(
    "T",
    DIGEST,
    recastDeps(
      { verdict: "keep", theme: "T", newestSourceDate: null },
      { ctx, nowIso: "2026-07-07T00:00:00.000Z" },
    ),
  );
  ok(
    "null date → no warning ever",
    computeGateWarnings(ctx.telemetry.article ?? {}, 1500).length === 0,
  );
}

// kill → records theme-killed through the channel, THEN throws.
{
  const ctx = createRunContext("run_c4_kill");
  let msg = "";
  try {
    await recastTheme(
      "T",
      DIGEST,
      recastDeps(
        {
          verdict: "kill",
          theme: "T",
          note: "contradicted by the evidence",
          newestSourceDate: null,
        },
        { ctx, nowIso: "2026-07-07T00:00:00.000Z" },
      ),
    );
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(
    "kill throws theme-killed with the note",
    msg === "theme-killed: contradicted by the evidence",
  );
  ok(
    "kill records the warning before throwing",
    computeGateWarnings(ctx.telemetry.article ?? {}, 1500).includes(
      "theme-killed: contradicted by the evidence",
    ),
  );
}

process.stdout.write(f ? `\n${f} FAILED, ${p} passed\n` : `\nALL ${p} passed\n`);
if (f) process.exit(1);
