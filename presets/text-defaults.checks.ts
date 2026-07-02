/**
 * Checks for the generic text/format defaults the preset binds into
 * PipelineDeps. Pure functions — every case runs offline.
 *
 *   npx tsx presets/text-defaults.checks.ts
 */
import {
  stripPreambleAndFence,
  isArticleShaped,
  lengthSafe,
  countVagueBanding,
  dropDuplicateSentences,
  findRepeatedShingles,
  shingleOccurrences,
  emdashClusteredLines,
  META_PROSE_RE,
  COT_PREFIX_RE,
  PREAMBLE_LINE_RE,
} from "./text-defaults";

let failures = 0;
const ok = (name: string, cond: boolean, detail: string): void => {
  if (cond) process.stdout.write(`PASS ${name}\n`);
  else {
    failures += 1;
    process.stdout.write(`FAIL ${name} — ${detail}\n`);
  }
};

ok(
  "stripPreambleAndFence: whole-body fence unwrapped",
  stripPreambleAndFence("```markdown\n## H\nbody\n```") === "## H\nbody",
  "fence must be stripped",
);
ok(
  "stripPreambleAndFence: leading hand-off line dropped",
  stripPreambleAndFence(
    "Here is the revised article:\n\n## H\nbody",
  ) === "## H\nbody",
  "preamble line must be dropped",
);
ok(
  "stripPreambleAndFence: clean text untouched",
  stripPreambleAndFence("## H\nbody") === "## H\nbody",
  "must be identity on clean input",
);
ok(
  "isArticleShaped: same-shape candidate accepted",
  isArticleShaped("## A\ntext\n## B\ntext", "## X\nt\n## Y\nt"),
  "two-H2 candidate vs two-H2 reference",
);
ok(
  "isArticleShaped: collapsed candidate rejected",
  !isArticleShaped("just a paragraph", "## X\nt\n## Y\nt\n## Z\nt"),
  "0-heading candidate vs 3-heading reference must fail",
);
ok(
  "lengthSafe: in-band output kept",
  lengthSafe("pass", "aaaaaaaaaa", "bbbbbbbb") === "bbbbbbbb",
  "80% of input is within 70–130%",
);
ok(
  "lengthSafe: out-of-band output discarded (input returned)",
  lengthSafe("pass", "aaaaaaaaaa", "b") === "aaaaaaaaaa",
  "10% of input must be rejected",
);
ok(
  "countVagueBanding: counts vague pay phrases",
  // Two DISTINCT vague-banding phrases the generic list recognizes:
  // "competitive salary" + "commensurate with experience". (The original
  // fixture read "Salaries are competitive" — reversed word order the
  // phrase list deliberately does not match — so it scored 1, not 2; the
  // assertion INTENT is "two vague-banding phrases", preserved here.)
  countVagueBanding(
    "We offer a competitive salary. Pay is commensurate with experience.",
  ) >= 2,
  "two vague-banding phrases",
);
{
  const { text, dropped } = dropDuplicateSentences(
    "This exact sentence repeats verbatim across the draft body. Unique middle here. This exact sentence repeats verbatim across the draft body.",
    40,
  );
  ok(
    "dropDuplicateSentences: later duplicate removed",
    dropped === 1 && text.split("This exact sentence").length === 2,
    `dropped=${dropped}`,
  );
}
ok(
  "findRepeatedShingles: repeated 6-gram found",
  findRepeatedShingles(
    "the quick brown fox jumps over x. later the quick brown fox jumps over y.",
    6,
  ).length >= 1,
  "must find 'the quick brown fox jumps over'",
);
ok(
  "shingleOccurrences: returns padded context quotes",
  shingleOccurrences("aaa needle in a haystack zzz", "needle in a haystack", 4)
    .length === 1,
  "one occurrence expected",
);
ok(
  "emdashClusteredLines: counts ≥3-emdash sentences",
  emdashClusteredLines("A — b — c — d. Clean sentence.") === 1,
  "one clustered sentence",
);
ok(
  "META_PROSE_RE matches meta prose",
  META_PROSE_RE.test("Here are the checks I performed on the draft"),
  "must match",
);
ok(
  "COT_PREFIX_RE matches chain-of-thought opener",
  COT_PREFIX_RE.test("Let me identify the key issues first"),
  "must match",
);
ok(
  "PREAMBLE_LINE_RE matches hand-off line",
  PREAMBLE_LINE_RE.test("Here is the revised article:"),
  "must match",
);

process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nALL passed\n");
if (failures) process.exit(1);
