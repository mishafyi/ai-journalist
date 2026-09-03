/**
 * Rotation checks for gemini-llm.ts — the free tier's limits are the whole
 * reason this client exists, so the ROTATION is what gets tested:
 *
 *   npx tsx clients/gemini-llm.checks.ts
 *
 * Offline by construction, and aimed at `createRotation` rather than at the
 * client: what matters is WHICH model gets asked and WHEN, which is decided
 * entirely there. Driving it through the SDK would test Google's mood and the
 * SDK's constructor, neither of which is ours.
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
  ok("the shipped list leads with the only model that survives a desk prompt",
    FREE_MODELS[0] === "gemini-3.5-flash-lite" && FREE_MODELS.includes("gemma-4-26b-a4b-it"),
    FREE_MODELS.join(","));

  const models = ["first", "second", "third"];

  // A rate-limited model must not cost the caller a wait — the next one serves
  // the call immediately. That is the entire point of the rotation.
  let asked: string[] = [];
  const rotate = createRotation(models);
  const started = Date.now();
  const got = await rotate("complete", undefined, async (m) => {
    asked.push(m);
    if (m === "first") throw rateLimited(30);
    return `served by ${m}`;
  });
  const elapsed = Date.now() - started;
  ok("a rate-limited model advances to the next one", got === "served by second", got);
  ok("advancing does NOT wait out the retryDelay", elapsed < 1_000, `${elapsed}ms`);
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
  // being masked by a tour of every remaining model.
  asked = [];
  let raised = "";
  await createRotation(models)("complete", undefined, async (m) => {
    asked.push(m);
    throw new Error("400 INVALID_ARGUMENT: schema is malformed");
  }).catch((e: unknown) => { raised = String(e); });
  ok("a non-limit error propagates at once and tries only one model",
    raised.includes("INVALID_ARGUMENT") && asked.length === 1, `${raised.slice(0, 50)} | ${asked.join(">")}`);

  // Every model limited → one clear error naming what was tried, never a hang
  // and never a silent empty answer.
  raised = "";
  await createRotation(["a-model", "b-model"])("complete", undefined, async () => {
    throw rateLimited(0);
  }).catch((e: unknown) => { raised = String(e); });
  ok("all models limited → an error naming the candidates",
    raised.includes("a-model") && raised.includes("b-model") && raised.includes("rate-limited"),
    raised.slice(0, 110));

  // A caller naming its own model is pinned: rotation must never move a
  // deliberate choice onto a different model behind the caller's back.
  asked = [];
  await createRotation(models)("complete", "pinned-model", async (m) => {
    asked.push(m);
    throw rateLimited(0);
  }).catch(() => undefined);
  ok("an explicitly named model never rotates to another",
    asked.length > 0 && asked.every((m) => m === "pinned-model"), asked.join(">"));

  // When everything is cooling it waits for the SOONEST expiry and then
  // succeeds, rather than failing while a model is seconds from ready.
  asked = [];
  let attempt = 0;
  const waited = Date.now();
  const late = await createRotation(["only"])("complete", undefined, async (m) => {
    asked.push(m);
    attempt += 1;
    if (attempt === 1) throw rateLimited(1);
    return "recovered";
  });
  ok("with every model cooling it waits the shortest cooldown, then retries",
    late === "recovered" && Date.now() - waited >= 900, `${Date.now() - waited}ms, asked=${asked.join(">")}`);

  process.stdout.write(failures ? `\n${failures} FAILED\n` : "\ngemini-llm checks: all green\n");
  if (failures) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`gemini-llm.checks failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
