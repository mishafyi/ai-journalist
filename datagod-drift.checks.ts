/**
 * Drift tripwire for the DataGod integration: every path template the
 * DATA_PLAYS menu can emit must still exist in the datagod repo's published
 * endpoint index (docs/endpoints.csv on the default branch). Runs live
 * against raw.githubusercontent.com — SKIPs cleanly offline so the normal
 * gate never depends on the network; CI runs it on push + a weekly cron so
 * upstream datagod changes surface within days, automatically.
 *
 *   npx tsx datagod-drift.checks.ts
 */
import { DATA_PLAYS, FRED_SERIES_WHITELIST } from "./presets/news-desk";

const INDEX_URL =
  "https://raw.githubusercontent.com/mishafyi/datagod/main/docs/endpoints.csv";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  let csv: string;
  try {
    const res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    csv = await res.text();
  } catch (err: unknown) {
    process.stdout.write(
      `SKIP datagod drift — endpoint index unreachable (${String(err).slice(0, 80)}); this check needs the network\n`,
    );
    return;
  }

  // Concrete request paths each play can emit, mapped to the CSV's templates.
  const expectations: { play: string; csvPath: string }[] = [
    { play: "fred_series", csvPath: "/fred/{series_id}" },
    { play: "usaspending_search", csvPath: "/usaspending/search" },
    { play: "nasdaq_price", csvPath: "/nasdaq/price/{ticker}" },
    { play: "treasury_debt", csvPath: "/treasury/debt" },
  ];
  for (const e of expectations) {
    ok(
      `endpoint index still lists ${e.csvPath} (play ${e.play})`,
      csv.includes(`,${e.csvPath},`),
      `not found in ${INDEX_URL}`,
    );
  }
  ok(
    "every DATA_PLAYS id has a drift expectation (menu and tripwire in sync)",
    DATA_PLAYS.every((p) => expectations.some((e) => e.play === p.id)),
    DATA_PLAYS.map((p) => p.id).join(","),
  );
  ok(
    "FRED whitelist is non-empty (selection has real series to offer)",
    FRED_SERIES_WHITELIST.length > 0,
    String(FRED_SERIES_WHITELIST.length),
  );

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("datagod drift checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`datagod-drift.checks failed: ${String(err)}\n`);
  process.exit(1);
});
