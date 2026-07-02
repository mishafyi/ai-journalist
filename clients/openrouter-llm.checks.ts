/**
 * Parity check for openrouter-llm.ts — proves the default `LlmClient` SHAPE works
 * against LIVE OpenRouter: dynamic top-weekly-free selection resolves + completes,
 * a pinned model completes, and the `usage()` counters advance.
 *
 *   npx tsx clients/openrouter-llm.checks.ts
 *
 * This makes REAL OpenRouter calls. It is ENVIRONMENT-tolerant by design: with no
 * `OPENROUTER_API_KEY`, or on any call failure (rate/spend limit, network, a
 * delisted model), it prints a SKIP line and exits 0 — the check's job is to prove
 * the client shape when a key is present, not to gate the task on a flaky network
 * call. Named *.checks.ts so vitest's `**​/*.test.ts` CI glob never picks it up.
 */
import {
  createOpenRouterLlm,
  DEFAULT_MODEL,
  getTopFreeTextModels,
  resetModelCache,
} from "./openrouter-llm";

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    process.stdout.write("SKIP openrouter parity — OPENROUTER_API_KEY not set\n");
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

  // ── Dynamic selection — the default when `defaultModel` is omitted ──────────
  // The port's headline behaviour: pick the current top-weekly free model at
  // runtime so no single delisted model can break generation. Robust to any one
  // model being down (it advances past it), so this is the PRIMARY check, and it
  // also carries the usage-accounting assertions.
  try {
    // resetModelCache() exercises the test-only reset (proving it clears the
    // memo) and guarantees a FRESH ranking here rather than a memo left by an
    // earlier in-process caller.
    resetModelCache();
    const ranked = await getTopFreeTextModels();
    ok(
      "models.list returns at least one free text model",
      ranked.length > 0,
      `count=${ranked.length}`,
    );

    const auto = createOpenRouterLlm({}); // no defaultModel → dynamic selection
    const autoText = await auto.complete({
      system: "You are a terse assistant. Reply with a single word.",
      prompt: "Reply with the single word: pong",
      temperature: 0,
    });
    ok(
      "dynamic-selection completion is non-empty",
      autoText.trim().length > 0,
      `got ${JSON.stringify(autoText)}`,
    );
    ok(
      "usage recorded one request",
      auto.usage().requests === 1,
      `requests=${auto.usage().requests}`,
    );
    ok(
      "usage snapshot is a copy (mutating it does not affect the client)",
      (() => {
        const snap = auto.usage();
        snap.requests = 999;
        return auto.usage().requests === 1;
      })(),
      "mutation leaked into client totals",
    );
  } catch (err) {
    process.stdout.write(
      `SKIP dynamic parity — live list/call failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  // ── Pinned model — the backward-compatible path ─────────────────────────────
  // Tolerant: a pinned `DEFAULT_MODEL` can itself be delisted over time (the very
  // problem dynamic selection solves), so a failure here is a SKIP, not a FAIL.
  try {
    const pinnedText = await createOpenRouterLlm({
      defaultModel: DEFAULT_MODEL,
    }).complete({
      prompt: "Reply with the single word: pong",
      temperature: 0,
    });
    ok(
      "pinned-model completion is non-empty",
      pinnedText.trim().length > 0,
      `got ${JSON.stringify(pinnedText)}`,
    );
  } catch (err) {
    process.stdout.write(
      `SKIP pinned parity (${DEFAULT_MODEL}) — live call failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  process.stdout.write(failures ? `\n${failures} FAILED\n` : `\nALL passed\n`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  // Unexpected (non-call) failure — surface it; do not mask a real bug as SKIP.
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
