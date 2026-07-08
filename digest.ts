/** Extractive six-box research digest (Blundell indexing): organize raw
 * research BY STORY-ASPECT, not by source. Extractive-only — verbatim spans +
 * URL + date — because downstream fact-guarding treats research as ground
 * truth; a paraphrased digest would launder model text into that ground truth.
 * Writers read digests; the guards always read the RAW corpus. */
import { z } from "zod";
import type { LlmClient } from "./ports";
import type { RunContext } from "./run-context";
import type { SectionWriterDeps } from "./section-writer";

export interface DigestDeps {
  llm: LlmClient;
  model: string;
  withRetry: SectionWriterDeps["withRetry"];
  /** C4 (recastTheme only): the per-run telemetry carrier. The staleness/kill
   *  warnings are recorded as flags on `ctx.telemetry.article` — the SAME
   *  channel the gate passes write — so `computeGateWarnings` relays them into
   *  the host's publish-blockers list with zero adapter changes. Absent → the
   *  recast still runs, but records nothing. */
  ctx?: RunContext;
  /** C4 (recastTheme only): staleness window in days (the adapter binds
   *  BLOG_MAX_STORY_AGE_DAYS — the engine reads no env). Default 14. */
  maxStoryAgeDays?: number;
  /** C4 (recastTheme only): "now" for the staleness age math, ISO string
   *  (injected for determinism). Default `new Date().toISOString()`. */
  nowIso?: string;
}

export async function buildDigest(
  raw: string,
  label: string,
  deps: DigestDeps,
): Promise<string> {
  const prompt = `Today is ${new Date().toISOString().slice(0, 10)}. Below is raw research for a story ("${label}"). Index it into the six boxes a reporter uses, as a markdown outline with EXACTLY these H2 headings: HISTORY, SCOPE, REASONS, IMPACTS, COUNTERMOVES, FUTURES.
Rules: every bullet is a VERBATIM span copied from the research (a figure, claim, or quote — never paraphrase, never merge two sources into one bullet), followed by " — " + its source URL and the source's publication date in parentheses, normalized to YYYY-MM-DD, when a date is stated or clearly inferable anywhere in that source's text (relative forms like "3 days ago" resolve against today's date given at the top; omit the parenthetical when no date is discernible — never guess from a bare year). Rank bullets inside each box by importance to the story. Drop navigation junk, boilerplate, and duplicates (keep the newest dated duplicate). A box with nothing real stays empty ("- (nothing found)").

RAW RESEARCH:
${raw}

=== YOUR TASK, RESTATED ===
Output ONLY the six-box markdown outline described at the top — verbatim bullets with URL + date, ranked, de-junked. No preamble, no commentary.`;
  return deps.withRetry(`digest: ${label}`, () =>
    deps.llm.complete({ prompt, model: deps.model, temperature: 0.1 }),
  );
}

/** The recast verdict — structured output of the theme-recast checkpoint. */
export const RecastResult = z.object({
  verdict: z.enum(["keep", "adjust", "kill"]),
  theme: z.string().min(1),
  note: z.string().optional(),
  /** Newest publication date among the digest's sources (YYYY-MM-DD) — the
   *  staleness gate's input. null when the digest carries no discernible
   *  dates (the gate then never fires). Zod v4 z.iso.date() validates the
   *  format; no code-side date parsing exists. */
  newestSourceDate: z.iso.date().nullable(),
});
export type RecastResult = z.infer<typeof RecastResult>;

/**
 * C4 — the TRUE theme-recast checkpoint: judge the planned theme against the
 * ORGANIZED evidence (the general digest) after research, before the section
 * writes. Structured output via the LLM port's `completeStructured` (grammar
 * constrains the shape — no hand-rolled JSON parsing).
 *
 * Side channels (both record-only, through the gate-warnings mechanism —
 * `ctx.telemetry.article` string flags relayed by `computeGateWarnings`):
 *   - staleness: a non-null `newestSourceDate` older than the window records
 *     `stale-story: newest dated source <date> is <n>d old (max <m>)`; a null
 *     date never fires (the gate never fires blind).
 *   - kill: records `theme-killed: <note>` then THROWS the same message — the
 *     host's fail-soft run catch owns terminal kills (the anti-repetition
 *     re-pick in discovery is the softer cousin; kill is terminal by design).
 */
export async function recastTheme(
  theme: string,
  generalDigest: string,
  deps: DigestDeps,
): Promise<RecastResult> {
  const prompt = `The story was planned with this MAIN THEME: "${theme}"
Below is the ORGANIZED RESEARCH actually gathered. Judge the theme against the evidence.

${generalDigest}

=== YOUR TASK, RESTATED ===
Judge the MAIN THEME at the top against the organized research above, and fill the structured fields:
- verdict: "keep" | "adjust" | "kill" — "kill" means the evidence cannot support any version of this story (contradicted, or nothing material found).
- theme: the theme, recast in 1-2 action sentences to match what the EVIDENCE supports — unchanged if verdict is keep.
- note: one sentence: why.
- newestSourceDate: the latest YYYY-MM-DD date visible on any source in the digest, or null if none carries a date.`;
  const result = await deps.withRetry("recast-theme", () =>
    deps.llm.completeStructured({
      messages: [{ role: "user", content: prompt }],
      schema: RecastResult,
      schemaName: "recast_theme",
      model: deps.model,
      temperature: 0.1,
    }),
  );

  const recordWarning = (flag: "staleStory" | "themeKilled", msg: string): void => {
    if (!deps.ctx) return;
    deps.ctx.telemetry.article = {
      ...(deps.ctx.telemetry.article ?? {}),
      [flag]: msg,
    };
  };

  if (result.newestSourceDate !== null) {
    const nowIso = deps.nowIso ?? new Date().toISOString();
    const maxDays = deps.maxStoryAgeDays ?? 14;
    const ageDays = Math.floor(
      (Date.parse(nowIso) - Date.parse(result.newestSourceDate)) / 86_400_000,
    );
    if (ageDays > maxDays) {
      recordWarning(
        "staleStory",
        `stale-story: newest dated source ${result.newestSourceDate} is ${ageDays}d old (max ${maxDays})`,
      );
    }
  }

  if (result.verdict === "kill") {
    const msg = `theme-killed: ${result.note ?? "(no note)"}`;
    recordWarning("themeKilled", msg);
    throw new Error(msg);
  }
  return result;
}
