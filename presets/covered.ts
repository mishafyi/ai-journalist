/**
 * Covered-check: is this trending headline a story the paper already ran?
 *
 * The host hands over the ledger; `recentCovered` keeps the last 72 hours
 * (undated entries stay — we cannot prove they are old). `judgeCovered` asks
 * the model SAME / FOLLOWUP / NEW against that numbered list. Embeddings
 * never see this path: their cosine floor treated different stories as
 * already covered, and the trigram fallback after quota exhaustion published
 * the same story twice.
 */
import { z } from "zod";
import { readRules } from "../rules";
import type { CoveredTopic, LlmClient } from "../ports";

export const COVERED_WINDOW_MS = 72 * 60 * 60 * 1000;
export const COVERED_RULES = readRules("covered");

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
  log?: (line: string) => void;
}): Promise<CoveredVerdict> {
  if (args.recent.length === 0) return { kind: "new" };
  const list = args.recent.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
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
      if (n === undefined || n < 1 || n > args.recent.length) {
        args.log?.(
          `news-desk: covered-check returned ${out.verdict} with no matching index — treating as new`,
        );
        return { kind: "new" };
      }
      const topic = args.recent[n - 1];
      if (topic === undefined) return { kind: "new" };
      return { kind: out.verdict, topic };
    } catch (err: unknown) {
      args.log?.(`news-desk: covered-check attempt ${attempt}/2 failed: ${String(err)}`);
    }
  }
  args.log?.(`news-desk: "${args.headline}" covered-check failed after 2 attempts — skipping`);
  return { kind: "blocked" };
}
