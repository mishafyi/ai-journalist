/**
 * Behavioral checks for text.ts — the blog generator's parsing layer.
 *
 * Run directly (no test framework — the host adapter runs main() on import, so the
 * suite imports text.ts ONLY; deliberately named *.checks.ts, NOT *.test.ts,
 * so vitest's `**​/*.test.ts` CI glob never picks it up):
 *
 *   npx tsx text.checks.ts
 *
 * Prints one PASS/FAIL line per case; exits 1 on any failure.
 */
import {
  splitSentences,
  extractRelativeLinks,
  countHeadings,
  hasInBodyH1,
  tableRowCount,
  parseUsDate,
  convertPairedEmdashParentheticals,
  cosineSimilarity,
  dropRepeatedClauses,
  extractFigures,
  extractFigureSpans,
  figureGrounded,
  findUngroundedFigureRaws,
} from "./text";

let failures = 0;
let passes = 0;
function ok(name: string, cond: boolean, detail: string): void {
  if (cond) {
    passes += 1;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`FAIL ${name} — ${detail}\n`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}, got ${a}`);
}

// ── splitSentences ───────────────────────────────────────────────────────────
// Abbreviations: V8's "en" Segmenter ships no break suppressions, so "U.S."
// splits exactly like the old `/(?<=[.!?])\s+/` regex did — asserted here as
// documented PARITY so a future ICU upgrade that changes it is caught loudly.
eq(
  "splitSentences: abbreviation parity (U.S. splits, like the old regex)",
  splitSentences("The U.S. Government hired 40 engineers. Next year doubles."),
  ["The U.S.", "Government hired 40 engineers.", "Next year doubles."],
);
eq(
  "splitSentences: decimal period is not a boundary",
  splitSentences("It raised $1.5 billion in 2024."),
  ["It raised $1.5 billion in 2024."],
);
eq(
  "splitSentences: sentence boundary after a magnitude figure",
  splitSentences("It raised $1.5 billion. Next came the layoffs."),
  ["It raised $1.5 billion.", "Next came the layoffs."],
);
// Quote-trailing punctuation: the old regex required whitespace directly
// after [.!?] and MERGED these two sentences; the Segmenter splits them.
eq(
  "splitSentences: closing curly quote ends the sentence",
  splitSentences("He said, “Stop hiring.” Then the market turned."),
  ["He said, “Stop hiring.”", "Then the market turned."],
);
eq(
  "splitSentences: closing straight quote ends the sentence",
  splitSentences(
    'He said "we cannot hire fast enough." Hiring doubled anyway.',
  ),
  ['He said "we cannot hire fast enough."', "Hiring doubled anyway."],
);
eq(
  "splitSentences: newline is a mandatory break (heading stays its own segment)",
  splitSentences("## Heading line\nBody sentence one. Body two."),
  ["## Heading line", "Body sentence one.", "Body two."],
);
eq("splitSentences: empty input", splitSentences(""), []);
eq("splitSentences: whitespace-only input", splitSentences("  \n  "), []);

// ── extractRelativeLinks — the 16 verdict shapes enforceLinkIntegrity rules on
// (static keeps, person/blog/location slugs, search shapes, company canonical/
// wrong-industry/subpages, salaries, deep-job downgrade, unknown slug) plus
// the operator-named body shapes: nested brackets, links in tables, CTA links.
const LINK_FIXTURE = [
  "Intro with [home](/) and [people hub](/people) and [companies hub](/companies) and [blog hub](/blog).",
  "",
  "Profiles: [Tim Ellis](/people/tim-ellis) wrote [an old post](/blog/space-hiring-2026) from [Austin](/locations/austin).",
  "",
  "Search: [engineering search](/space-engineering-jobs) and [robotics jobs](/robotics-jobs).",
  "",
  "Companies: [SpaceX](/space-companies/spacex) vs [Anduril](/ai-companies/anduril) — see [careers](/space-companies/spacex/careers) but not [financials](/space-companies/spacex/financials).",
  "",
  "Pay: [SpaceX pay](/space-salaries/spacex); deep link [senior avionics](/space-jobs/spacex/senior-avionics-1234); ghost [Nonexistent](/space-companies/nonexistent-co?ref=x#frag).",
  "",
  "Nested brackets: [see [docs]](/space-jobs) parses as one link, and an empty-text link [](/hire) must not crash extraction.",
  "",
  "| Company | Link |",
  "| --- | --- |",
  "| SpaceX | [SpaceX](/space-companies/spacex?utm=table) |",
  "",
  "Must NOT extract: [absolute](https://example.com/space-jobs), ![logo image](/logos/spacex.png), and code:",
  "",
  "```",
  "[fenced](/never-a-link)",
  "```",
  "",
  "Inline `[code](/also-never)` stays code.",
  "",
  "---",
  "",
  "**Working in space?** Example News tracks the openings: browse [space jobs](/space-jobs), openings at [Apex](/space-companies/apex) and [the people](/people) building the field.",
].join("\n");
const extracted = extractRelativeLinks(LINK_FIXTURE);
eq(
  "extractRelativeLinks: every verdict shape extracted, in document order",
  extracted.map((l) => `${l.text}|${l.url}`),
  [
    "home|/",
    "people hub|/people",
    "companies hub|/companies",
    "blog hub|/blog",
    "Tim Ellis|/people/tim-ellis",
    "an old post|/blog/space-hiring-2026",
    "Austin|/locations/austin",
    "engineering search|/space-engineering-jobs",
    "robotics jobs|/robotics-jobs",
    "SpaceX|/space-companies/spacex",
    "Anduril|/ai-companies/anduril",
    "careers|/space-companies/spacex/careers",
    "financials|/space-companies/spacex/financials",
    "SpaceX pay|/space-salaries/spacex",
    "senior avionics|/space-jobs/spacex/senior-avionics-1234",
    "Nonexistent|/space-companies/nonexistent-co?ref=x#frag",
    "see [docs]|/space-jobs",
    "|/hire", // empty link text — extraction must survive `[](/x)`
    "SpaceX|/space-companies/spacex?utm=table",
    "space jobs|/space-jobs",
    "Apex|/space-companies/apex",
    "the people|/people",
  ],
);
ok(
  "extractRelativeLinks: absolute / image / fenced / inline-code links excluded",
  !extracted.some((l) =>
    ["/logos/spacex.png", "/never-a-link", "/also-never"].includes(l.url),
  ) && !extracted.some((l) => l.url.startsWith("http")),
  `got urls: ${extracted.map((l) => l.url).join(", ")}`,
);
// Position fidelity — the splice in enforceLinkIntegrity depends on exact
// source offsets, so every span must round-trip to its own source.
ok(
  "extractRelativeLinks: every position round-trips to `[text](url)` source",
  extracted.every(
    (l) =>
      LINK_FIXTURE.slice(l.position.start, l.position.end) ===
      `[${l.text}](${l.url})`,
  ),
  "a span sliced to something other than its own [text](url) source",
);
// Splice rehearsal — unwrap every link the way the gate does and verify no
// half-link debris survives (the regex-replace path this replaced was exact;
// the offset-splice path must be too).
{
  let out = "";
  let cursor = 0;
  for (const l of extracted) {
    out += LINK_FIXTURE.slice(cursor, l.position.start) + l.text;
    cursor = l.position.end;
  }
  out += LINK_FIXTURE.slice(cursor);
  ok(
    "extractRelativeLinks: full-unwrap splice leaves no relative-link debris",
    !out.includes("](/space-companies/spacex)") &&
      out.includes("see [docs] parses as one link") &&
      out.includes("| SpaceX | SpaceX |") &&
      out.includes("[fenced](/never-a-link)") && // fenced code untouched
      out.includes("`[code](/also-never)`"), // inline code untouched
    `splice output corrupted: ${out.slice(0, 200)}`,
  );
}

// ── countHeadings / hasInBodyH1 / tableRowCount ─────────────────────────────
const ARTICLE_FIXTURE = [
  "# Lead Title",
  "",
  "Intro paragraph.",
  "",
  "## Section One",
  "",
  "Body text.",
  "",
  "## Section Two",
  "",
  "| Role | Pay |",
  "| --- | --- |",
  "| Engineer | $100k |",
  "| Scientist | $200k |",
  "",
  "## Section Three",
  "",
  "### Subsection",
  "",
  "```",
  "## not a heading (fenced)",
  "# also not a heading",
  "```",
].join("\n");
eq("countHeadings: depth 1", countHeadings(ARTICLE_FIXTURE, 1), 1);
eq(
  "countHeadings: depth 2 (fenced ## ignored)",
  countHeadings(ARTICLE_FIXTURE, 2),
  3,
);
eq("countHeadings: depth 3", countHeadings(ARTICLE_FIXTURE, 3), 1);
eq(
  "tableRowCount: header + body rows, delimiter line not a row",
  tableRowCount(ARTICLE_FIXTURE),
  3,
);
eq(
  "tableRowCount: pipeless GFM table is counted (the old ^| count missed it)",
  tableRowCount("Role | Pay\n--- | ---\nEng | $100k\nSci | $200k"),
  3,
);
eq("tableRowCount: no table", tableRowCount("Just prose. No pipes here."), 0);
eq(
  "hasInBodyH1: lead H1 only (draft shape) is not in-body",
  hasInBodyH1("# Title\n\nBody text."),
  false,
);
eq(
  "hasInBodyH1: lead H1 + stray H1 is in-body",
  hasInBodyH1("# Title\n\nBody.\n\n# Stray Duplicate"),
  true,
);
eq(
  "hasInBodyH1: non-leading H1 is in-body",
  hasInBodyH1("Lede paragraph first.\n\n# Late Title"),
  true,
);
eq(
  "hasInBodyH1: no H1 at all",
  hasInBodyH1("## Only Sections\n\nBody."),
  false,
);

// ── parseUsDate ──────────────────────────────────────────────────────────────
{
  const d = parseUsDate("April 21, 2026");
  ok(
    "parseUsDate: 'April 21, 2026' parses to local 2026-04-21",
    d !== null &&
      d.getFullYear() === 2026 &&
      d.getMonth() === 3 &&
      d.getDate() === 21,
    `got ${d?.toString() ?? "null"}`,
  );
}
{
  const d = parseUsDate("April 21 2026"); // comma optional in the gate's regex
  ok(
    "parseUsDate: comma-less 'April 21 2026' parses",
    d !== null &&
      d.getFullYear() === 2026 &&
      d.getMonth() === 3 &&
      d.getDate() === 21,
    `got ${d?.toString() ?? "null"}`,
  );
}
{
  const d = parseUsDate("April  21,   2026"); // multi-space normalized
  ok(
    "parseUsDate: irregular whitespace normalized",
    d !== null && d.getDate() === 21,
    `got ${d?.toString() ?? "null"}`,
  );
}
eq(
  "parseUsDate: out-of-range day rejected (no Date() rollover)",
  parseUsDate("April 99, 2026"),
  null,
);
eq(
  "parseUsDate: garbage month rejected",
  parseUsDate("Aprilish 21, 2026"),
  null,
);
eq("parseUsDate: empty string rejected", parseUsDate(""), null);

// ── convertPairedEmdashParentheticals ───────────────────────────────────────
const DASH_FIXTURE = [
  "## Heading — with dash — stays", // heading: skipped
  "| pay — note — cell | — |", // table line: skipped ("—" is the empty-cell marker)
  "> quoted — aside — block", // blockquote: skipped
  "He said “the market — frankly — stalled” on stage.", // quoted span: skipped
  "First — early aside — sentence stands.", // eligible pair
  "A single — dash sentence.", // single dash: NEVER touched
  "Last — late aside — sentence closes.", // eligible pair (converted first: right-to-left)
].join("\n");
// 14 em-dashes total: 2 heading + 3 table + 2 blockquote + 2 quoted + 2 + 1 + 2.
eq(
  "paired-dash fixture: baseline em-dash count",
  (DASH_FIXTURE.match(/—/g) ?? []).length,
  14,
);
{
  const r = convertPairedEmdashParentheticals(DASH_FIXTURE, 12);
  eq("paired-dash cap 12: exactly one conversion", r.converted, 1);
  ok(
    "paired-dash cap 12: rightmost eligible pair converted first (right-to-left)",
    r.text.includes("Last (late aside) sentence closes.") &&
      r.text.includes("First — early aside — sentence stands."),
    r.text,
  );
  eq(
    "paired-dash cap 12: dash count lands on the cap",
    (r.text.match(/—/g) ?? []).length,
    12,
  );
}
{
  const r = convertPairedEmdashParentheticals(DASH_FIXTURE, 10);
  eq("paired-dash cap 10: both eligible pairs converted", r.converted, 2);
  ok(
    "paired-dash cap 10: both parentheticals now parenthesized",
    r.text.includes("First (early aside) sentence stands.") &&
      r.text.includes("Last (late aside) sentence closes."),
    r.text,
  );
}
{
  const r = convertPairedEmdashParentheticals(DASH_FIXTURE, 0);
  const lines = r.text.split("\n");
  eq(
    "paired-dash cap 0: only the two eligible pairs ever convert",
    r.converted,
    2,
  );
  eq(
    "paired-dash cap 0: heading line untouched",
    lines[0],
    "## Heading — with dash — stays",
  );
  eq(
    "paired-dash cap 0: table line untouched",
    lines[1],
    "| pay — note — cell | — |",
  );
  eq(
    "paired-dash cap 0: blockquote line untouched",
    lines[2],
    "> quoted — aside — block",
  );
  eq(
    "paired-dash cap 0: quoted span untouched",
    lines[3],
    "He said “the market — frankly — stalled” on stage.",
  );
  eq(
    "paired-dash cap 0: single dash never touched",
    lines[5],
    "A single — dash sentence.",
  );
}
{
  const r = convertPairedEmdashParentheticals(DASH_FIXTURE, 14);
  eq("paired-dash under cap: no-op (converted 0)", r.converted, 0);
  eq("paired-dash under cap: text byte-identical", r.text, DASH_FIXTURE);
}
{
  // Straight-quoted span is skipped too.
  const line =
    'Plan A failed. He warned "costs — frankly — exploded" twice. Plan B — the cheap one — shipped.';
  const r = convertPairedEmdashParentheticals(line, 2);
  ok(
    "paired-dash: straight-quoted span skipped, unquoted pair converted",
    r.text.includes('"costs — frankly — exploded"') &&
      r.text.includes("Plan B (the cheap one) shipped."),
    r.text,
  );
}

// ── extractFigures / figureGrounded / findUngroundedFigureRaws ──────────────
// The figure-gate incident regression matrix (round-8 redesign): one labeled
// check per real incident the old substring-needle gate mishandled. These
// labels ARE the institutional record — the needle-expansion blocks that
// carried the R5-R7 comments in the adapter were deleted in favor of numeric
// normalization, and this matrix pins every behavior they encoded.

// Compact figure signature: "unit:value" with "~" marking range endpoints.
const figs = (text: string): string[] =>
  extractFigures(text).map(
    (f) => `${f.unit}:${String(f.value)}${f.approx === true ? "~" : ""}`,
  );
// Mirrors the adapter's findUngroundedFigures (which adds per-corpus caching +
// article-side URL stripping) with the production 200-char USD-range window.
const ungrounded = (article: string, corpus: string): string[] =>
  findUngroundedFigureRaws(article, extractFigureSpans(corpus), 200);

// — extraction: every surface form parses to the same value/unit space —
eq("figures: $-comma form", figs("$272,000"), ["USD:272000"]);
eq("figures: $-K suffix", figs("$272K"), ["USD:272000"]);
eq("figures: $-decimal-K suffix", figs("$85.6K"), ["USD:85600"]);
eq("figures: $-decimal-M suffix", figs("$1.23M"), ["USD:1230000"]);
eq("figures: $-magnitude word", figs("$362.9 million"), ["USD:362900000"]);
eq("figures: $-bn press form", figs("$1.5bn"), ["USD:1500000000"]);
eq("figures: cents decimal", figs("$26.50"), ["USD:26.5"]);
eq(
  "figures: '585.4 thousand' parses as 585400 (R7C4 note: unit word applies)",
  figs("585.4 thousand"),
  ["count:585400"],
);
eq(
  "figures: BLS parenthesized '(thousands)' (R7C4 corpus form)",
  figs("Employment: 585.4 (thousands)"),
  ["count:585400"],
);
eq("figures: percent", figs("4.3%"), ["percent:4.3"]);
eq("figures: percent word", figs("45 percent"), ["percent:45"]);
eq(
  "figures: percent range yields both endpoints, shared unit, approx",
  figs("30-50%"),
  ["percent:30~", "percent:50~"],
);
eq("figures: percent range with per-endpoint signs", figs("30% to 50%"), [
  "percent:30~",
  "percent:50~",
]);
eq(
  "figures: bare magnitude range — low endpoint inherits the suffix (R6C8)",
  figs("22-25k"),
  ["count:22000~", "count:25000~"],
);
eq("figures: USD 'to' range (R7C9 band form)", figs("$160,000 to $340,000"), [
  "USD:160000~",
  "USD:340000~",
]);
eq(
  "figures: USD range with per-endpoint suffixes + trailing plus",
  figs("$500k-$1M+"),
  ["USD:500000~", "USD:1000000~"],
);
eq("figures: USD range with shared magnitude word", figs("$30-50 million"), [
  "USD:30000000~",
  "USD:50000000~",
]);
eq("figures: bare year is a count (R7C1)", figs("2029"), ["count:2029"]);
eq("figures: comma-grouped bare count", figs("585,400 technicians"), [
  "count:585400",
]);
eq(
  "figures: 401(k)/401k are plan tokens, not 401,000 counts",
  figs("a 401k match and a 401(k) plan"),
  [],
);
eq(
  "figures: 'in 2026 to 50%' is prose, not a 2026-to-50 percent band",
  figs("revenue grew in 2026 to 50% margins"),
  ["count:2026", "percent:50"],
);
eq(
  "figures: spaced em-dash is a clause break, not a range",
  figs("costs $5 — $10 is the ceiling"),
  ["USD:5", "USD:10"],
);
eq(
  "figures: '$3 million to 400 engineers' — 400 is not a money endpoint",
  figs("spent $3 million to 400 engineers' benefit"),
  ["USD:3000000"],
);

// — grounding semantics —
ok(
  "grounded: USD matches USD regardless of surface form",
  figureGrounded({ raw: "$194,000", value: 194000, unit: "USD" }, [
    { raw: "$194k", value: 194000, unit: "USD" },
  ]),
  "value-equal USD figures must ground",
);
ok(
  "grounded: a count never grounds a USD figure (unit strictness, R5C7/R7C9)",
  !figureGrounded({ raw: "$160,000", value: 160000, unit: "USD" }, [
    { raw: "160,000", value: 160000, unit: "count" },
  ]),
  "count 160000 must not ground $160,000",
);
ok(
  "grounded: ±0.5% relative tolerance accepts press rounding",
  figureGrounded({ raw: "$100,400", value: 100400, unit: "USD" }, [
    { raw: "$100,000", value: 100000, unit: "USD" },
  ]),
  "0.398% off must ground",
);
ok(
  "grounded: beyond ±0.5% rejected",
  !figureGrounded({ raw: "$100,600", value: 100600, unit: "USD" }, [
    { raw: "$100,000", value: 100000, unit: "USD" },
  ]),
  "0.596% off must not ground",
);
ok(
  "grounded: years are exact — 2029 never grounds on 2019 (R7C1)",
  !figureGrounded({ raw: "2029", value: 2029, unit: "count" }, [
    { raw: "2019", value: 2019, unit: "count" },
  ]) &&
    figureGrounded({ raw: "2029", value: 2029, unit: "count" }, [
      { raw: "2029", value: 2029, unit: "count" },
    ]),
  "year tolerance must be zero",
);
ok(
  "grounded: small integer counts are exact",
  !figureGrounded({ raw: "500", value: 500, unit: "count" }, [
    { raw: "501", value: 501, unit: "count" },
  ]),
  "counts under 1000 must match exactly",
);

// — incident matrix: end-to-end through findUngroundedFigureRaws —
eq(
  "R6C5: article $194,000 grounds on corpus $194k",
  ungrounded(
    "Senior pay reaches $194,000 today.",
    "Glassdoor pegs it at $194k for seniors.",
  ),
  [],
);
eq(
  "R6C8: article 22,000 grounds on corpus range 22-25k (endpoint inherits suffix)",
  ungrounded("about 22,000 new roles", "analysts project 22-25k roles by 2030"),
  [],
);
eq(
  "R7C4: article 585,400 grounds on corpus BLS '585.4 (thousands)'",
  ungrounded(
    "the BLS counts 585,400 technicians",
    "Employment, 2024: 585.4 (thousands), projected",
  ),
  [],
);
eq(
  "R7C5: article $272K/$85.6K ground on corpus $272,000/$85,566 (±0.5% proof)",
  ungrounded(
    "The table lists $272K base and $85.6K median.",
    "filings show $272,000 base salary and an $85,566 median",
  ),
  [],
);
eq(
  "R7C7: article 4.3% grounds on corpus 4.3% (datagod unit-suffixed)",
  ungrounded("wages grew 4.3% last year", "BLS series: wage growth 4.3% (CES)"),
  [],
);
eq(
  "R7C9: article $362.9 million grounds on corpus $362,974,500",
  ungrounded(
    "won $362.9 million in federal awards",
    "USAspending total: $362,974,500 across awards",
  ),
  [],
);
eq(
  "R7C10: article $1,230,000 grounds on corpus $1.23M (mirrored direction)",
  ungrounded("a $1,230,000 modification", "the award later rose to $1.23M"),
  [],
);
eq(
  "R7C9 TRUE-POSITIVE: $160,000-to-$340,000 band vs unrelated bare 160/340 still flags",
  ungrounded(
    "Offers range from $160,000 to $340,000 at the primes.",
    "She ran 160 simulations across 340 test units last quarter.",
  ),
  ["$160,000 to $340,000"],
);
eq(
  "R7C1: fabricated year 2029 flags when the corpus only has 2019",
  ungrounded("the backlog clears by 2029", "shipped 10× the volume in 2019"),
  ["2029"],
);
eq(
  "R7C9/R7C10: '$1 million' grounds on corpus band '$500k-$1M+'",
  ungrounded(
    "packages top out at $1 million",
    "comp spans $500k-$1M+ at the frontier labs",
  ),
  [],
);
eq(
  "R5C7: percent range 30-50% flags when corpus has only 40-50% + bare 30",
  ungrounded(
    "comp rose 30-50% in two years",
    "Bangalore comp rose 40-50% since 2023, with 30 offices opened.",
  ),
  ["30-50%"],
);
eq(
  "R5C7: $1.2 trillion flags against corpus $1.5T + bare 1.2 (unit + magnitude aware)",
  ungrounded(
    "a $1.2 trillion market",
    "the market is $1.5T per BCG, a 1.2 multiplier on 2020",
  ),
  ["$1.2 trillion"],
);
eq(
  "R6C10: article $100M grounds on corpus-verbatim $100M+",
  ungrounded("having raised $100M", "raised $100M+ to scale production"),
  [],
);
eq(
  "bare-small skip: 1-digit suffix-free figures ($5, 9%) are never checked",
  ungrounded("a $5 fee and 9% of teams and 3 sites", "no numbers here at all"),
  [],
);
eq(
  "trailing zeros: article $26.50 grounds on corpus $26.5",
  ungrounded("$26.50 an hour", "rates start at $26.5/hr"),
  [],
);
eq(
  "dedup: a figure repeated in the article reports once",
  ungrounded("$777,123 twice: $777,123.", "nothing relevant"),
  ["$777,123"],
);
// — round-8 item 3e: USD-range endpoint co-occurrence (synthesized bands) —
{
  const farCorpus =
    `entry packages start at $150,000 for new grads. ${"Filler prose. ".repeat(30)}` +
    `Director-level equity refreshers reached $300,000 last cycle.`;
  eq(
    "3e: USD band whose endpoints sit >200 chars apart in the corpus flags (synthesized band)",
    ungrounded("Offers run $150,000 to $300,000.", farCorpus),
    ["$150,000 to $300,000"],
  );
  eq(
    "3e: USD band grounds when endpoints co-occur within 200 chars",
    ungrounded(
      "Offers run $150,000 to $300,000.",
      "Levels.fyi puts the band at $150,000 base and $300,000 total comp.",
    ),
    [],
  );
  eq(
    "3e: USD band grounds on a corpus-stated range (distance 0)",
    ungrounded(
      "Offers run $150,000 to $300,000.",
      "the published band is $150,000-$300,000 for L5",
    ),
    [],
  );
  eq(
    "3e: non-range USD singles are NOT held to co-occurrence",
    ungrounded("base is $150,000 and total comp hits $300,000", farCorpus),
    [],
  );
}

// R8 smoke incident: "$500,000 to $1 million" parsed its low side as $500B —
// magnitude inheritance must only apply to bare short low sides.
eq(
  "USD range: full low side does not inherit high magnitude",
  extractFigures("$500,000 to $1 million")
    .map((f) => f.value)
    .join(","),
  "500000,1000000",
);
// R8 smoke incident: boardTruth emits "385000–595000 USD/YEAR" (no $) — every
// real board band flagged as count↔USD mismatch until USD-word forms landed.
eq(
  "USD-word range grounds the $-comma article form",
  extractFigures("$385,000–$595,000").every((f) =>
    figureGrounded(
      f,
      extractFigures("PM, Enterprise — 385000–595000 USD/YEAR"),
    ),
  ),
  true,
);
// Null-min board lines render "?–211000 USD/YEAR" — the high side must still
// parse as a USD single (the "?" low side is unparseable by design).
eq(
  "USD-word single survives the null-min board form",
  figs("Eng — ?–211000 USD/YEAR"),
  ["USD:211000"],
);
// The R8 $500B inheritance class, count side: a comma-grouped low side is
// already fully scaled and must not inherit the high magnitude word.
eq(
  "count range: full low side does not inherit high magnitude",
  figs("from 120,000 to 150 thousand jobs"),
  ["count:120000~", "count:150000~"],
);

// ── dropRepeatedClauses (round-8 item #4 — R7C9 clause backstop) ─────────────
{
  // The R7C9 class: a ≥40-char clause (with a decimal inside — boundary must
  // not split "$1.5") embedded in two DIFFERENT sentences. Later copy drops;
  // the rest of both lines survives verbatim.
  const triplet =
    "the program won the $1.5M AFWERX award, the SBIR Phase II award, and the NASA TIPS award;";
  const doc = [
    `He kept the budget tight. The clause is that ${triplet} hiring doubled.`,
    "Unrelated middle prose stays put.",
    `Then the wins piled up. The clause is that ${triplet} rivals noticed.`,
  ].join("\n");
  const r = dropRepeatedClauses(doc, 40);
  ok(
    "dropRepeatedClauses: later duplicate clause dropped, first kept, decimals intact (R7C9)",
    r.dropped === 1 &&
      r.text.includes(`The clause is that ${triplet} hiring doubled.`) &&
      r.text.includes("Then the wins piled up. rivals noticed.") &&
      r.text.includes("Unrelated middle prose stays put."),
    `dropped=${r.dropped}, text=${r.text}`,
  );
}
{
  // A repeated ≥40-char substring that is NOT punctuation/line-bounded (the
  // full clauses differ at their tails) must never be touched — no
  // mid-sentence surgery, ever.
  const doc = [
    "Critics said the rapid expansion of orbital manufacturing capacity changed budgets.",
    "Backers said the rapid expansion of orbital manufacturing capacity changed politics.",
  ].join("\n");
  const r = dropRepeatedClauses(doc, 40);
  ok(
    "dropRepeatedClauses: repeated substring inside differing clauses untouched",
    r.dropped === 0 && r.text === doc,
    `dropped=${r.dropped}, text=${r.text}`,
  );
}
{
  // Short repeated clauses (< minChars normalized) and structural lines
  // (headings/tables/blockquotes) are exempt.
  const doc = [
    "## The same heading clause repeats here forever and ever amen.",
    "## The same heading clause repeats here forever and ever amen.",
    "| the same table cell clause repeats here forever and ever | x |",
    "| the same table cell clause repeats here forever and ever | x |",
    "Hiring surged; pay rose. Hiring surged; pay rose.",
  ].join("\n");
  const r = dropRepeatedClauses(doc, 40);
  ok(
    "dropRepeatedClauses: short clauses + structural lines never dropped",
    r.dropped === 0 && r.text === doc,
    `dropped=${r.dropped}, text=${r.text}`,
  );
}

// ── cosineSimilarity (round-8 #8 — embedding meaning-cousin dedup) ──────────
// Synthetic vectors with perfect-square norms so the expected values are
// EXACT floats (no epsilon): |[3,4]| = 5, |[6,8]| = 10.
eq(
  "cosineSimilarity: parallel vectors → 1 (scale-invariant)",
  cosineSimilarity([3, 4], [6, 8]),
  1,
);
eq(
  "cosineSimilarity: orthogonal vectors → 0",
  cosineSimilarity([1, 0], [0, 1]),
  0,
);
eq(
  "cosineSimilarity: opposite vectors → -1",
  cosineSimilarity([3, 4], [-3, -4]),
  -1,
);

// ── summary ──────────────────────────────────────────────────────────────────
process.stdout.write(
  failures === 0
    ? `\nALL ${passes} checks passed\n`
    : `\n${failures} of ${passes + failures} checks FAILED\n`,
);
if (failures > 0) process.exit(1);
