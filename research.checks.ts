/**
 * Offline checks for research.ts — pure query hygiene first (Task 1);
 * later tasks append tier/throttle/gather/extract sections.
 *
 *   npx tsx research.checks.ts
 */
import { sanitizeQuery, relaxQuery } from "./research";

let failures = 0;
const ok = (name: string, cond: boolean, detail: string): void => {
  if (cond) process.stdout.write(`PASS ${name}\n`);
  else {
    failures += 1;
    process.stdout.write(`FAIL ${name} — ${detail}\n`);
  }
};

// Async main from the start (matches clients/ollama-llm.checks.ts exactly) —
// later tasks append await-ing sections inside it without restructuring.
async function main(): Promise<void> {

// sanitizeQuery — the single choke point every search routes through.
ok(
  "typographic quotes are normalized",
  sanitizeQuery("„EU tariff" + "”" + " impact") === '"EU tariff" impact',
  String(sanitizeQuery("„EU tariff” impact")),
);
ok(
  "ideation-scaffold line with empty slot is rejected",
  sanitizeQuery("reasons: psychological - ") === null,
  String(sanitizeQuery("reasons: psychological - ")),
);
ok("sub-8-char query is rejected", sanitizeQuery("details") === null,
  String(sanitizeQuery("details")));
ok("trailing-dash empty slot is rejected", sanitizeQuery("history: EU -") === null,
  String(sanitizeQuery("history: EU -")));
ok(
  "leading interrogatives are stripped (dictionary-junk guard)",
  sanitizeQuery("why does the EU fine platforms?") === "the EU fine platforms",
  String(sanitizeQuery("why does the EU fine platforms?")),
);
ok(
  "stripping is skipped when it would fall under the 8-char floor",
  sanitizeQuery("why tariffs?") === "why tariffs?",
  String(sanitizeQuery("why tariffs?")),
);

// relaxQuery — the empty-result recovery form.
ok(
  "site:/intitle:/negations/quotes are stripped",
  relaxQuery('site:reuters.com intitle:tariff -"opinion" "EU trade"') ===
    "tariff EU trade",
  relaxQuery('site:reuters.com intitle:tariff -"opinion" "EU trade"'),
);

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("research checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`research.checks failed: ${String(err)}\n`);
  process.exit(1);
});
