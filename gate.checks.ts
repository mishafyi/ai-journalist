/** Checks for gate.ts. Run: npx tsx gate.checks.ts */
import { computeGateWarnings } from "./gate";
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
ok("clean → []", computeGateWarnings({}, 1500).length === 0);
ok(
  "unguarded flagged",
  computeGateWarnings({ unguarded: true }, 1500).includes(
    "fact-guard failed twice — article is unguarded",
  ),
);
ok(
  "board-data flagged",
  computeGateWarnings({ boardDataUsedInPrint: false }, 1500).some((w) =>
    w.includes("first-party board data"),
  ),
);
ok(
  "multiple",
  computeGateWarnings({ unguarded: true, titleTruncated: true }, 1500)
    .length === 2,
);
ok(
  "word floor interpolated",
  computeGateWarnings({ wordsBelowTarget: true }, 1500).some((w) =>
    w.includes("1500"),
  ),
);
ok(
  "boardData true → no warning",
  computeGateWarnings({ boardDataUsedInPrint: true }, 1500).length === 0,
);
// C4: the recast checkpoint records its warnings as pre-built strings (the
// message needs run data — date/age/window — only the recast site knows).
ok(
  "stale-story string flag passes through verbatim",
  computeGateWarnings(
    { staleStory: "stale-story: newest dated source 2026-06-01 is 36d old (max 14)" },
    1500,
  ).includes("stale-story: newest dated source 2026-06-01 is 36d old (max 14)"),
);
ok(
  "theme-killed string flag passes through verbatim",
  computeGateWarnings({ themeKilled: "theme-killed: nope" }, 1500).includes(
    "theme-killed: nope",
  ),
);
process.stdout.write(
  f ? `\n${f} FAILED, ${p} passed\n` : `\nALL ${p} passed\n`,
);
if (f) process.exit(1);
