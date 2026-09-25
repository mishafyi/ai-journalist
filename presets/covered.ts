/**
 * Covered-check: is this trending headline a story the paper already ran?
 *
 * The host hands over the ledger; `recentCovered` keeps the last 72 hours
 * (undated entries stay — we cannot prove they are old). `judgeCovered` asks
 * the model SAME / FOLLOWUP / NEW against that list, newest first, each column
 * with its age, so the index lands on the thread's LATEST column — the one
 * `withinCooldown` then measures. Embeddings never see this path: their cosine
 * floor treated different stories as already covered, and the trigram
 * fallback after quota exhaustion published the same story twice.
 */
import { z } from "zod";
import { readRules } from "../rules";
import type { CoveredTopic, LlmClient } from "../ports";

export const COVERED_WINDOW_MS = 72 * 60 * 60 * 1000;
/** A FOLLOWUP of a column younger than this files as developing, not as a new
 *  column: 37 of 61 FOLLOWUP columns (2026-09-20..24) followed one under a day
 *  old, and each became another Short on the same story. */
export const FOLLOWUP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const COVERED_RULES = readRules("covered");

const HOUR_MS = 60 * 60 * 1000;

/** Ms since `topic` ran; null when it carries no parseable date. */
function ageMs(topic: CoveredTopic, now: number): number | null {
  if (topic.date === undefined || topic.date === "") return null;
  const ms = Date.parse(topic.date);
  return Number.isNaN(ms) ? null : now - ms;
}

/** Pure. Whether `topic` ran less than `cooldownMs` before `now`. An undated
 *  column is never inside it: nothing proves it is recent. */
export function withinCooldown(topic: CoveredTopic, now: number, cooldownMs: number): boolean {
  const age = ageMs(topic, now);
  return age !== null && age < cooldownMs;
}

export type CoveredVerdict =
  | { kind: "new" }
  | { kind: "same" | "followup"; topic: CoveredTopic }
  | { kind: "blocked" };

export function recentCovered(
  topics: readonly CoveredTopic[],
  now: number,
  windowMs: number,
): CoveredTopic[] {
  return topics.filter((t) => {
    if (t.date === undefined || t.date === "") return true;
    const ms = Date.parse(t.date);
    if (Number.isNaN(ms)) return true;
    return now - ms <= windowMs;
  });
}

const CoveredSchema = z.object({
  verdict: z.enum(["same", "followup", "new"]),
  index: z.number().int().optional(),
});

export async function judgeCovered(args: {
  llm: LlmClient;
  headline: string;
  recent: readonly CoveredTopic[];
  now: number;
  log?: (line: string) => void;
}): Promise<CoveredVerdict> {
  if (args.recent.length === 0) return { kind: "new" };
  // Newest first; undated last, in ledger order (NaN compares as equal).
  const shown = [...args.recent].sort((a, b) => (ageMs(a, args.now) ?? Infinity) - (ageMs(b, args.now) ?? Infinity));
  const list = shown
    .map((t, i) => {
      const age = ageMs(t, args.now);
      return `${i + 1}. [${age === null ? "age unknown" : `${Math.floor(age / HOUR_MS)}h ago`}] ${t.title}`;
    })
    .join("\n");
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const out = await args.llm.completeStructured({
        messages: [
          {
            role: "system",
            content: `You are a wire editor deciding whether a trending headline is a story the paper already published.\n\nRULES:\n${COVERED_RULES}`,
          },
          { role: "user", content: `TRENDING: ${args.headline}\n\nRECENT COLUMNS:\n${list}` },
        ],
        schema: CoveredSchema,
        schemaName: "covered_check",
        temperature: 0,
      });
      if (out.verdict === "new") return { kind: "new" };
      const n = out.index;
      if (n === undefined || n < 1 || n > shown.length) {
        args.log?.(
          `news-desk: covered-check returned ${out.verdict} with no matching index — treating as new`,
        );
        return { kind: "new" };
      }
      const topic = shown[n - 1];
      if (topic === undefined) return { kind: "new" };
      return { kind: out.verdict, topic };
    } catch (err: unknown) {
      args.log?.(`news-desk: covered-check attempt ${attempt}/2 failed: ${String(err)}`);
    }
  }
  args.log?.(`news-desk: "${args.headline}" covered-check failed after 2 attempts — skipping`);
  return { kind: "blocked" };
}

