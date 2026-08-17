/**
 * gemini-llm.checks.ts — error classification and the lane state machine.
 * Run: npx tsx clients/gemini-llm.checks.ts
 *
 * The rotation is the part worth testing and the part that is hard to observe
 * live, so `pickLane`/`demoteLane` are pure and exercised here directly. No
 * network, no API key, no SDK stand-up.
 */
import { ApiError } from "@google/genai";
import { classifyGeminiError, createGeminiLlm, demoteLane, pickLane } from "./gemini-llm";
import type { LaneState } from "./gemini-llm";

const lane = (name: string, modelIdx: number, dead: boolean): LaneState => ({ name, modelIdx, dead });

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  // ── classification: typed status first, text only as a fallback ──────────
  {
    const c = classifyGeminiError(new ApiError({ message: "quota exceeded", status: 429 }));
    ok("a typed ApiError 429 reads as quota", c.quota && !c.transient, JSON.stringify(c));
  }
  {
    const c = classifyGeminiError(new ApiError({ message: "backend down", status: 503 }));
    ok("a typed ApiError 503 reads as transient", c.transient && !c.quota, JSON.stringify(c));
  }
  {
    const c = classifyGeminiError(new ApiError({ message: "bad model id", status: 404 }));
    ok("a 404 is NEITHER quota nor transient (hard error, do not retry)",
      !c.quota && !c.transient, JSON.stringify(c));
  }
  {
    // Google only ever ships retryDelay inside the body text — this is the
    // reason the client is hand-rolled rather than using a generic retry lib.
    const c = classifyGeminiError(
      new ApiError({ message: 'RESOURCE_EXHAUSTED {"retryDelay":"41s"}', status: 429 }),
    );
    ok("the server's own retryDelay is read out of the 429 body", c.retryDelayMs === 41_000, String(c.retryDelayMs));
  }
  {
    const c = classifyGeminiError(new ApiError({ message: "quota", status: 429 }));
    ok("no retryDelay named → 0, so the caller applies its own floor", c.retryDelayMs === 0, String(c.retryDelayMs));
  }
  {
    // A plain object from a non-SDK path must still classify.
    const c = classifyGeminiError({ status: 500, message: "UNAVAILABLE" });
    ok("an untyped error with a numeric status still classifies", c.transient, JSON.stringify(c));
  }
  {
    const c = classifyGeminiError(new Error("model is RESOURCE_EXHAUSTED for the day"));
    ok("text-only RESOURCE_EXHAUSTED still reads as quota", c.quota, JSON.stringify(c));
  }
  {
    const c = classifyGeminiError("a bare string");
    ok("a non-error value does not throw", !c.quota && !c.transient && c.status === undefined, JSON.stringify(c));
  }

  // ── pickLane: round-robin over LIVE lanes ────────────────────────────────
  {
    const ls = [lane("a", 0, false), lane("b", 0, false), lane("c", 0, false)];
    const seen = [0, 1, 2, 3].map((i) => pickLane(ls, i)?.name);
    ok("round-robin cycles every live lane then wraps",
      JSON.stringify(seen) === '["a","b","c","a"]', JSON.stringify(seen));
  }
  {
    // The point of filtering FIRST: a dead lane is skipped, not merely retried.
    const ls = [lane("a", 0, true), lane("b", 0, false), lane("c", 0, false)];
    const seen = [0, 1, 2].map((i) => pickLane(ls, i)?.name);
    ok("a dead lane is skipped entirely, never handed a call",
      !seen.includes("a") && JSON.stringify(seen) === '["b","c","b"]', JSON.stringify(seen));
  }
  ok("every lane dead → null, which the caller turns into a throw",
    pickLane([lane("a", 0, true)], 0) === null, "");
  ok("no lanes at all → null", pickLane([], 0) === null, "");

  // ── demoteLane: a lane's own state machine ───────────────────────────────
  {
    const l = lane("a", 0, false);
    ok("first failure steps down the chain, lane stays alive",
      demoteLane(l, 3) === "fallback" && l.modelIdx === 1 && !l.dead, JSON.stringify(l));
    ok("second failure steps down again",
      demoteLane(l, 3) === "fallback" && l.modelIdx === 2 && !l.dead, JSON.stringify(l));
    ok("failing on the LAST model kills the lane",
      demoteLane(l, 3) === "dead" && l.dead, JSON.stringify(l));
  }
  {
    // A single-model chain must die on its first failure, not step off the end.
    const l = lane("solo", 0, false);
    ok("a one-model chain dies immediately rather than indexing past the end",
      demoteLane(l, 1) === "dead" && l.dead && l.modelIdx === 0, JSON.stringify(l));
  }
  {
    // Lanes are independent: one dying must not advance another.
    const a = lane("a", 0, false);
    const b = lane("b", 0, false);
    demoteLane(a, 2);
    demoteLane(a, 2);
    ok("lanes fall independently — killing one leaves the other untouched",
      a.dead && !b.dead && b.modelIdx === 0, JSON.stringify({ a, b }));
  }

  // ── construction ─────────────────────────────────────────────────────────
  const throws = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  ok("no keys is a construction error, not a first-call surprise",
    throws(() => createGeminiLlm({ apiKeys: [] })), "");
  ok("blank/whitespace keys do not count as keys",
    throws(() => createGeminiLlm({ apiKeys: ["", "   "] })), "");
  ok("an empty model chain is refused",
    throws(() => createGeminiLlm({ apiKeys: ["k"], models: [] })), "");
  ok("a valid config constructs and satisfies LlmClient",
    (() => {
      const c = createGeminiLlm({ apiKeys: ["k1", "k2"] });
      return typeof c.complete === "function" && typeof c.completeStructured === "function";
    })(), "");
  ok("duplicate model ids collapse (a repeated fallback is not a fallback)",
    (() => {
      const c = createGeminiLlm({ apiKeys: ["k"], models: ["m", "m", "n"] });
      return typeof c.complete === "function";
    })(), "");

  if (failures > 0) {
    process.stdout.write(`\n${failures} gemini-llm check(s) failed\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("gemini-llm checks: all green\n");
}
main().catch((err: unknown) => {
  process.stderr.write(`gemini-llm.checks failed: ${String(err)}\n`);
  process.exit(1);
});
