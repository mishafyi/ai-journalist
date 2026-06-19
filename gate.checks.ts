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
process.stdout.write(
  f ? `\n${f} FAILED, ${p} passed\n` : `\nALL ${p} passed\n`,
);
if (f) process.exit(1);
