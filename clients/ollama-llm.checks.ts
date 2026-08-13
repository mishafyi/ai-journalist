/** Transport-retry behaviour of the Ollama client — run: npx tsx clients/ollama-llm.checks.ts */
import { createOllamaLlm } from "./ollama-llm";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const realFetch = globalThis.fetch;
  const answer = (text: string): Response =>
    new Response(JSON.stringify({ message: { content: text } }), { status: 200 });

  // The failure this exists for: the runner is killed mid-request and the POST
  // dies as a dropped connection. It took 150 newsroom runs down.
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    if (calls < 3) throw new TypeError('fetch failed: Post "/tokenize": EOF');
    return answer("recovered");
  }) as typeof fetch;
  const llm = createOllamaLlm({ baseUrl: "http://x", model: "m" });
  const text = await llm.complete({ prompt: "p", model: "", temperature: 0 });
  ok("a dropped connection is retried and the run survives", text === "recovered" && calls === 3,
    `text=${text} calls=${calls}`);

  // A 5xx is the same class of failure — the server never answered.
  calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    return calls < 2 ? new Response("boom", { status: 503 }) : answer("ok");
  }) as typeof fetch;
  ok("a 5xx is retried", (await llm.complete({ prompt: "p", model: "", temperature: 0 })) === "ok" && calls === 2,
    `calls=${calls}`);

  // A 4xx is a bad request: retrying it verbatim only wastes the cycle.
  calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    return new Response("nope", { status: 400 });
  }) as typeof fetch;
  let threw = false;
  try {
    await llm.complete({ prompt: "p", model: "", temperature: 0 });
  } catch {
    threw = true;
  }
  ok("a 4xx fails immediately, without retrying", threw && calls === 1, `threw=${threw} calls=${calls}`);

  // Content failures still belong to the engine's own retry helpers.
  calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    return answer("   ");
  }) as typeof fetch;
  threw = false;
  try {
    await llm.complete({ prompt: "p", model: "", temperature: 0 });
  } catch {
    threw = true;
  }
  ok("an empty completion throws without a transport retry", threw && calls === 1,
    `threw=${threw} calls=${calls}`);

  // Persistent transport failure raises the last error rather than hanging.
  calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    throw new TypeError("still down");
  }) as typeof fetch;
  threw = false;
  try {
    await llm.complete({ prompt: "p", model: "", temperature: 0 });
  } catch {
    threw = true;
  }
  ok("a runner that never comes back raises after the last attempt", threw && calls === 3,
    `threw=${threw} calls=${calls}`);

  globalThis.fetch = realFetch;
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("ollama-llm checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`ollama-llm.checks failed: ${String(err)}\n`);
  process.exit(1);
});
