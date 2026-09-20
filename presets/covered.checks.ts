/** Covered-check: 72h window and the SAME / FOLLOWUP / NEW judgement.
 *  Run: npx tsx presets/covered.checks.ts */
import { readRules } from "../rules";
import { COVERED_WINDOW_MS, judgeCovered, recentCovered } from "./covered";
import type { LlmClient } from "../ports";

let failed = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  process.stdout.write(`${cond ? "PASS" : "FAIL"} ${name}${cond || detail === "" ? "" : ` — ${detail}`}\n`);
  if (!cond) failed += 1;
};

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-20T16:00:00.000Z");

ok(
  "COVERED_WINDOW_MS is 72 hours",
  COVERED_WINDOW_MS === 72 * HOUR,
  String(COVERED_WINDOW_MS),
);

ok("an empty ledger stays empty", recentCovered([], NOW, COVERED_WINDOW_MS).length === 0);

const undated = { title: "Undated column", slug: "undated" };
const fresh = { title: "Fresh column", slug: "fresh", date: "2026-09-19T16:00:00.000Z" }; // 24h
const edge = { title: "Edge column", slug: "edge", date: "2026-09-17T16:00:00.000Z" }; // exactly 72h
const stale = { title: "Stale column", slug: "stale", date: "2026-09-17T15:59:59.000Z" }; // 72h + 1s
const garbage = { title: "Bad date", slug: "bad", date: "not-a-date" };

const kept = recentCovered([undated, fresh, edge, stale, garbage], NOW, COVERED_WINDOW_MS);
ok(
  "undated, unparseable, and ≤72h stay; older than 72h drops",
  kept.map((t) => t.slug).join() === "undated,fresh,edge,bad" && !kept.some((t) => t.slug === "stale"),
  kept.map((t) => t.slug).join(),
);

function fakeLlm(reply: unknown | ((n: number) => unknown) | Error | Error[]): LlmClient {
  const calls: { schemaName: string; system: string; user: string }[] = [];
  let n = 0;
  const llm = {
    calls,
    async complete(): Promise<string> {
      throw new Error("complete unused");
    },
    async completeStructured<T>(args: {
      schemaName: string;
      messages: { role: string; content: string }[];
    }): Promise<T> {
      n += 1;
      const system = args.messages.find((m) => m.role === "system")?.content ?? "";
      const user = args.messages.find((m) => m.role === "user")?.content ?? "";
      calls.push({ schemaName: args.schemaName, system, user });
      const next = Array.isArray(reply) || typeof reply === "function" ? null : reply;
      const sequenced = Array.isArray(reply) ? reply[n - 1] : next;
      const computed = typeof reply === "function" ? reply(n) : sequenced;
      if (computed instanceof Error) throw computed;
      return computed as T;
    },
  };
  return llm as unknown as LlmClient & { calls: typeof calls };
}

const recent = [
  { title: "Smoke seen near Riyadh airport after air raid alerts in Saudi capital", slug: "riyadh-1" },
  { title: "Senate passes sweeping tariff bill after marathon vote", slug: "tariffs" },
];

{
  const llm = fakeLlm({ verdict: "same", index: 1 });
  const hit = await judgeCovered({
    llm,
    headline: "Thick smoke seen near Riyadh airport after air raid alerts",
    recent: [],
  });
  ok("an empty recent list is NEW and does not call the model", hit.kind === "new" && (llm as never as { calls: unknown[] }).calls.length === 0, JSON.stringify(hit));
}

{
  const llm = fakeLlm({ verdict: "same", index: 1 });
  const hit = await judgeCovered({
    llm,
    headline: "Thick smoke seen near Riyadh airport after air raid alerts",
    recent,
  });
  const calls = (llm as never as { calls: { schemaName: string; system: string; user: string }[] }).calls;
  ok("SAME returns that column", hit.kind === "same" && hit.topic.slug === "riyadh-1", JSON.stringify(hit));
  ok("the call is covered_check at temperature-shaped structured output", calls[0]?.schemaName === "covered_check", calls[0]?.schemaName);
  ok(
    "the user prompt numbers the recent columns and names the trending headline",
    calls[0]?.user.includes("TRENDING: Thick smoke seen near Riyadh airport after air raid alerts") &&
      calls[0]?.user.includes("1. Smoke seen near Riyadh airport") &&
      calls[0]?.user.includes("2. Senate passes sweeping tariff bill"),
    calls[0]?.user ?? "",
  );
  ok(
    "the system prompt is the rules file",
    calls[0]?.system.includes("RULES:") && calls[0]?.system.includes(readRules("covered")),
    (calls[0]?.system ?? "").slice(0, 200),
  );
}

{
  const llm = fakeLlm({ verdict: "followup", index: 1 });
  const hit = await judgeCovered({
    llm,
    headline: "Riyadh's air defenses fail as Houthis expose Saudi fragility",
    recent,
  });
  ok(
    "FOLLOWUP returns that column and is not SAME",
    hit.kind === "followup" && hit.topic.slug === "riyadh-1",
    JSON.stringify(hit),
  );
}

{
  const llm = fakeLlm({ verdict: "new" });
  const hit = await judgeCovered({ llm, headline: "Central bank raises rates", recent });
  ok("NEW is NEW", hit.kind === "new", JSON.stringify(hit));
}

{
  const llm = fakeLlm({ verdict: "same", index: 9 });
  const hit = await judgeCovered({ llm, headline: "Anything", recent });
  ok("an out-of-range index is treated as NEW", hit.kind === "new", JSON.stringify(hit));
}

{
  const llm = fakeLlm({ verdict: "same" });
  const hit = await judgeCovered({ llm, headline: "Anything", recent });
  ok("SAME with no index is treated as NEW", hit.kind === "new", JSON.stringify(hit));
}

{
  const llm = fakeLlm([new Error("timeout"), { verdict: "new" }]);
  const hit = await judgeCovered({ llm, headline: "Central bank raises rates", recent });
  const n = (llm as never as { calls: unknown[] }).calls.length;
  ok("a thrown first attempt is retried", hit.kind === "new" && n === 2, `kind=${hit.kind} calls=${n}`);
}

{
  const llm = fakeLlm([new Error("timeout"), new Error("still down")]);
  const hit = await judgeCovered({ llm, headline: "Central bank raises rates", recent });
  const n = (llm as never as { calls: unknown[] }).calls.length;
  ok("two thrown attempts block the story without naming a column", hit.kind === "blocked" && n === 2, `kind=${hit.kind} calls=${n}`);
}

if (failed > 0) {
  process.exitCode = 1;
  process.stdout.write(`covered.checks: ${failed} failed\n`);
} else {
  process.stdout.write("covered.checks: all green\n");
}
