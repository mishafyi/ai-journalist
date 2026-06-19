/** Checks for schemas.ts. Run: npx tsx schemas.checks.ts */
import { parseSignal, parseFacts, parseCovered } from "./schemas";
let f = 0,
  p = 0;
const ok = (n: string, c: boolean): void => {
  if (c) {
    p++;
  } else {
    f++;
  }
  process.stdout.write(`${c ? "PASS" : "FAIL"} ${n}\n`);
};
const threw = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// Valid signal parses (round-trips items + optional meta two-arg record).
ok(
  "valid signal parses",
  parseSignal({
    items: [
      {
        title: "SpaceX is hiring",
        summary: "1,768 open roles in aerospace",
        entities: ["SpaceX"],
        meta: { slug: "spacex" },
      },
    ],
    framing: "space hiring, last 24h",
  }).items[0].title === "SpaceX is hiring",
);

// Missing required field (item.title) throws.
ok(
  "signal missing title throws",
  threw(() => parseSignal({ items: [{ summary: "no title", entities: [] }] })),
);

// Valid facts parse (value string|number union round-trips).
ok(
  "valid facts parse",
  parseFacts({
    facts: [
      {
        claim: "SpaceX has 1,768 open roles",
        value: 1768,
        source: "Example News data desk",
      },
    ],
  }).facts[0].value === 1768,
);

// Missing required field (fact.source) throws.
ok(
  "facts missing source throws",
  threw(() => parseFacts({ facts: [{ claim: "no source" }] })),
);

// Valid covered topics parse.
ok(
  "valid covered parses",
  parseCovered([{ title: "Old story", slug: "old-story" }]).length === 1,
);

process.stdout.write(
  f ? `\n${f} FAILED, ${p} passed\n` : `\nALL ${p} passed\n`,
);
if (f) process.exit(1);
