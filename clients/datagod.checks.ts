/**
 * Offline checks for clients/datagod.ts (mocked fetch) + a live-skip parity
 * check against a real instance when DATAGOD_URL/DATAGOD_API_KEY are set.
 *
 *   npx tsx clients/datagod.checks.ts
 */
import { createDatagod } from "./datagod";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const calls: { url: string; headers: Record<string, string> }[] = [];
  let nextBody = JSON.stringify({
    meta: { source: "fred", endpoint: "/fred/GDP", timestamp: "t", status: "success" },
    data: { observations: [{ value: "1.0" }] },
    error: null,
  });
  let nextStatus = 200;
  const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(nextBody, { status: nextStatus });
  }) as typeof fetch;

  const dg = createDatagod({ apiUrl: "http://mock:8000/", apiKey: "k123", fetchImpl });

  const data = await dg.get("/fred/GDP", { limit: 6, sort_order: "desc" });
  ok("envelope unwrapped to data payload",
    JSON.stringify(data).includes("observations"), JSON.stringify(data).slice(0, 80));
  ok("key header + trailing-slash base + params serialized",
    calls[0].headers["X-API-Key"] === "k123" &&
      calls[0].url === "http://mock:8000/fred/GDP?limit=6&sort_order=desc",
    calls[0].url);

  nextStatus = 502;
  nextBody = "upstream timeout";
  let threwHttp = false;
  try {
    await dg.get("/treasury/debt");
  } catch (err: unknown) {
    threwHttp = String(err).includes("HTTP 502") && String(err).includes("/treasury/debt");
  }
  ok("HTTP error throws with path + status + body context", threwHttp, "http path");

  nextStatus = 200;
  nextBody = JSON.stringify({
    meta: { source: "fred", endpoint: "/fred/NOPE", timestamp: "t", status: "error" },
    data: null,
    error: "series not found",
  });
  let threwEnv = false;
  try {
    await dg.get("/fred/NOPE");
  } catch (err: unknown) {
    threwEnv = String(err).includes("series not found");
  }
  ok("envelope error throws with upstream message", threwEnv, "envelope path");

  // Live-skip parity (operator env only).
  if (!process.env.DATAGOD_URL || !process.env.DATAGOD_API_KEY) {
    process.stdout.write("SKIP datagod live parity — DATAGOD_URL/DATAGOD_API_KEY not set (this check makes live calls)\n");
  } else {
    const live = createDatagod({ apiUrl: process.env.DATAGOD_URL, apiKey: process.env.DATAGOD_API_KEY });
    const gdp = (await live.get("/fred/GDP", { limit: 2, sort_order: "desc" })) as { observations?: unknown[] };
    ok("live: FRED GDP returns observations through the envelope",
      Array.isArray(gdp.observations) && gdp.observations.length > 0,
      JSON.stringify(gdp).slice(0, 120));
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("datagod checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`datagod.checks failed: ${String(err)}\n`);
  process.exit(1);
});
