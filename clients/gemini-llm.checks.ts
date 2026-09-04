/**
 * Rotation checks for gemini-llm.ts — the free tier's limits are the whole
 * reason this client exists, so the ROTATION is what gets tested:
 *
 *   npx tsx clients/gemini-llm.checks.ts
 *
 * Offline by construction, and aimed at `createRotation` rather than at the
 * client: what matters is WHICH model and WHICH key get asked, and when. That
 * is decided entirely there. Driving it through the SDK would test Google's
 * mood and the SDK's constructor, neither of which is ours.
 */
import { createRotation, FREE_MODELS } from "./gemini-llm";

let failures = 0;
const ok = (name: string, cond: boolean, detail: string): void => {
  if (cond) process.stdout.write(`PASS ${name}\n`);
  else {
    failures += 1;
    process.stdout.write(`FAIL ${name} — ${detail}\n`);
  }
};

/** A 429 shaped like the one the free tier actually returns. */
const rateLimited = (seconds: number): Error =>
  new Error(`{"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"${seconds}s"}]}}`);

async function main(): Promise<void> {
  // Gemma leads by operator choice; Flash-Lite must stay in the list because a
  // single >16K-token prompt is refused by Gemma on EVERY key.
  ok("the shipped list leads with gemma and keeps a flash-lite fallback",
    FREE_MODELS[0].startsWith("gemma-4") && FREE_MODELS.includes("gemini-3.5-flash-lite"),
    FREE_MODELS.join(","));

  const models = ["first", "second", "third"];

  // ── model rotation, single key ────────────────────────────────────────────
  let asked: string[] = [];
  const rotate = createRotation(models, 1);
  const started = Date.now();
  const got = await rotate("complete", undefined, async (m) => {
    asked.push(m);
    if (m === "first") throw rateLimited(30);
    return `served by ${m}`;
  });
  ok("a rate-limited model advances to the next one", got === "served by second", got);
  ok("advancing does NOT wait out the retryDelay", Date.now() - started < 1_000, `${Date.now() - started}ms`);
  ok("it asked the preferred model first, then exactly one more",
    asked.join(">") === "first>second", asked.join(">"));

  // The cooldown is remembered, so a later call does not re-ask a model it has
  // just been told is limited — otherwise every call pays the same 429 again.
  asked = [];
  await rotate("complete", undefined, async (m) => {
    asked.push(m);
    return "ok";
  });
  ok("a cooling model is skipped on the NEXT call, not re-asked",
    asked.join(">") === "second", asked.join(">"));

  // A real error is a bug, not a budget: it must surface at once rather than
  // being masked by a tour of every remaining model and key.
  asked = [];
  let raised = "";
  await createRotation(models, 1)("complete", undefined, async (m) => {
    asked.push(m);
    throw new Error("400 INVALID_ARGUMENT: schema is malformed");
  }).catch((e: unknown) => { raised = String(e); });
  ok("a non-limit error propagates at once and tries only one model",
    raised.includes("INVALID_ARGUMENT") && asked.length === 1, `${raised.slice(0, 50)} | ${asked.join(">")}`);

  // Everything limited → one clear error naming what was tried, never a hang
  // and never a silent empty answer.
  raised = "";
  await createRotation(["a-model", "b-model"], 1)("complete", undefined, async () => {
    throw rateLimited(0);
  }).catch((e: unknown) => { raised = String(e); });
  ok("all models limited → an error naming the candidates",
    raised.includes("a-model") && raised.includes("b-model") && raised.includes("rate-limited"),
    raised.slice(0, 120));

  // A caller naming its own model is pinned: rotation must never move a
  // deliberate choice onto a different model behind the caller's back.
  asked = [];
  await createRotation(models, 1)("complete", "pinned-model", async (m) => {
    asked.push(m);
    throw rateLimited(0);
  }).catch(() => undefined);
  ok("an explicitly named model never rotates to another",
    asked.length > 0 && asked.every((m) => m === "pinned-model"), asked.join(">"));

  // When everything is cooling it waits for the SOONEST expiry and then
  // succeeds, rather than failing while a model is seconds from ready.
  let attempt = 0;
  const waited = Date.now();
  const late = await createRotation(["only"], 1)("complete", undefined, async () => {
    attempt += 1;
    if (attempt === 1) throw rateLimited(1);
    return "recovered";
  });
  ok("with everything cooling it waits the shortest cooldown, then retries",
    late === "recovered" && Date.now() - waited >= 900, `${Date.now() - waited}ms`);

  // ── the key ring ──────────────────────────────────────────────────────────
  // Free-tier limits are per PROJECT, so a model refused on one project's key
  // is fine on the next one's. Exhausting a model's keys before moving off it
  // is what makes "gemma first" mean anything.
  const seen: string[] = [];
  const served = await createRotation(["alpha", "beta"], 3)("complete", undefined, async (m, k) => {
    seen.push(`${m}#${k}`);
    if (m === "alpha" && k < 2) throw rateLimited(30);
    return `${m}#${k}`;
  });
  ok("a model limited on one key is retried on the NEXT key, not abandoned",
    served === "alpha#2" && seen.join(" ") === "alpha#0 alpha#1 alpha#2", seen.join(" "));

  const seen2: string[] = [];
  await createRotation(["alpha", "beta"], 2)("complete", undefined, async (m, k) => {
    seen2.push(`${m}#${k}`);
    if (m === "alpha") throw rateLimited(30);
    return "beta served";
  });
  ok("only after EVERY key fails does it advance to the next model",
    seen2.join(" ") === "alpha#0 alpha#1 beta#0", seen2.join(" "));

  // Every call starting at key 0 would burn one project's daily quota while
  // the rest sat idle, so the ring advances its start point per call.
  const starts: number[] = [];
  const spread = createRotation(["m"], 4);
  for (let i = 0; i < 4; i += 1) {
    await spread("complete", undefined, async (_m, k) => {
      starts.push(k);
      return "ok";
    });
  }
  ok("consecutive calls start on different keys, spreading the daily count",
    new Set(starts).size === 4, starts.join(","));

  process.stdout.write(failures ? `\n${failures} FAILED\n` : "\ngemini-llm checks: all green\n");
  if (failures) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`gemini-llm.checks failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
