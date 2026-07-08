/**
 * Checks for planning.ts — run: npx tsx planning.checks.ts
 */
import { parseDiscovery, parsePlan, themeOf, Plan } from "./planning";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${name}\n`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}\n`);
  }
}
function throws(name: string, fn: () => unknown): void {
  try {
    fn();
    failed++;
    process.stdout.write(`FAIL ${name}\n  expected a throw, got none\n`);
  } catch {
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  }
}

// --- parseDiscovery ---
const disco = parseDiscovery(
  `Here is the JSON:\n{"queries":["defense tech hiring surge","AI compute buildout"],"companies":["Anduril","SpaceX"]}\nThanks!`,
);
eq("discovery: queries parsed", disco.queries.length, 2);
eq("discovery: companies parsed", disco.companies, ["Anduril", "SpaceX"]);
// companies defaults to [] when omitted
eq(
  "discovery: companies default []",
  parseDiscovery(`{"queries":["one good query here"]}`).companies,
  [],
);
throws("discovery: no JSON → throws", () => parseDiscovery("no json here"));
throws("discovery: missing queries → throws", () =>
  parseDiscovery(`{"companies":["X"]}`),
);
throws("discovery: empty queries → throws (min 1)", () =>
  parseDiscovery(`{"queries":[]}`),
);

// --- parsePlan ---
const plan = parsePlan(
  '```json\n{"title":"The Defense-Tech Hiring Surge","angle":"why primes are losing engineers to startups","searchSeed":"defense tech salaries","sections":[{"heading":"The pay gap","intent":"show comp divergence","queries":["defense startup salaries 2026"]},{"heading":"The mission pull","intent":"non-comp draws","queries":[]}]}\n```',
);
eq("plan: title parsed", plan.title, "The Defense-Tech Hiring Surge");
eq("plan: searchSeed parsed", plan.searchSeed, "defense tech salaries");
eq("plan: section count", plan.sections.length, 2);
eq("plan: first section heading", plan.sections[0]?.heading, "The pay gap");
eq("plan: section queries default []", plan.sections[1]?.queries, []);
throws("plan: missing sections → throws", () =>
  parsePlan(`{"title":"T","angle":"A"}`),
);
throws("plan: empty sections → throws (min 1)", () =>
  parsePlan(`{"title":"T","angle":"A","sections":[]}`),
);
throws("plan: section missing intent → throws", () =>
  parsePlan(`{"title":"T","angle":"A","sections":[{"heading":"H"}]}`),
);
// A raw control char inside a JSON string value crashed runs ("Bad control
// character in string"); it should now be stripped to a space and parse.
const ctrl = String.fromCharCode(1);
eq(
  "plan: raw control char in string is sanitized (was a crash)",
  parsePlan(
    `{"title":"Defense${ctrl}Tech","angle":"a","sections":[{"heading":"h","intent":"i","queries":[]}]}`,
  ).title,
  "Defense Tech",
);

// --- themeOf (Part B, 2026-07: the ONLY reader of the plan's theme) ---
ok(
  "themeOf falls back to title — angle",
  themeOf({ title: "T", angle: "A" }) === "T — A",
);
ok(
  "themeOf prefers an explicit statement",
  themeOf({ title: "T", angle: "A", themeStatement: "S." }) === "S.",
);
ok(
  "Plan accepts themeStatement",
  Plan.safeParse({
    title: "t",
    angle: "a",
    sections: [{ heading: "h", intent: "i" }],
    themeStatement: "x",
  }).success,
);

process.stdout.write(
  failed === 0
    ? `\nALL ${passed} checks passed\n`
    : `\n${failed} FAILED, ${passed} passed\n`,
);
if (failed > 0) process.exit(1);
