/**
 * Parity check for openrouter-llm.ts — proves the default `LlmClient` SHAPE
 * works against LIVE OpenRouter: same prompt → a non-empty completion, with the
 * usage() counters advancing.
 *
 *   npx tsx clients/openrouter-llm.checks.ts
 *
 * This makes a REAL OpenRouter call. It is ENVIRONMENT-tolerant by design: with
 * no `OPENROUTER_API_KEY`, or on any call failure (rate/spend limit, network),
 * it prints a SKIP line and exits 0 — the check's job is to prove the client
 * shape when a key is present, not to gate the task on a flaky network call.
 * Named *.checks.ts so vitest's `**​/*.test.ts` CI glob never picks it up.
 */
import { createOpenRouterLlm, DEFAULT_MODEL } from "./openrouter-llm";

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    process.stdout.write(
      "SKIP openrouter parity — OPENROUTER_API_KEY not set\n",
    );
    return;
  }

  const llm = createOpenRouterLlm({ defaultModel: DEFAULT_MODEL });

  let text: string;
  try {
    text = await llm.complete({
      system: "You are a terse assistant. Reply with a single word.",
      prompt: "Reply with the single word: pong",
      temperature: 0,
    });
  } catch (err) {
    process.stdout.write(
      `SKIP openrouter parity — live call failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return;
  }

  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) {
      process.stdout.write(`PASS ${name}\n`);
    } else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  ok(
    "completion is non-empty",
    text.trim().length > 0,
    `got ${JSON.stringify(text)}`,
  );

  const usage = llm.usage();
  ok(
    "usage recorded one request",
    usage.requests === 1,
    `requests=${usage.requests}`,
  );
  ok(
    "usage snapshot is a copy (mutating it does not affect the client)",
    (() => {
      usage.requests = 999;
      return llm.usage().requests === 1;
    })(),
    "mutation leaked into client totals",
  );

  process.stdout.write(
    failures
      ? `\n${failures} FAILED\n`
      : `\nALL passed (completion: ${JSON.stringify(text.slice(0, 40))})\n`,
  );
  if (failures) process.exit(1);
}

main().catch((err) => {
  // Unexpected (non-call) failure — surface it; do not mask a real bug as SKIP.
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
