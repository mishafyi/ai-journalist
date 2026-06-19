/**
 * Pure text/markdown parsing utilities for the blog generator.
 *
 * This module is the PARSING layer extracted from generate.ts (2026-06-11
 * de-handroll pivot): sentence segmentation via Intl.Segmenter and markdown
 * structure via remark/mdast replace the bespoke regex NLP that accreted over
 * 17 review cycles. Decision logic stays in generate.ts — only the parsing
 * moved here.
 *
 * Contract: pure functions only — no side effects, no env reads, no DB, no
 * network. generate.ts runs main() on import, so tests import THIS module
 * directly (see text.checks.ts) and must never import generate.ts.
 */
import { parse as parseDateFns, isValid } from "date-fns";
import type { Heading, Link, Root } from "mdast";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";

// GFM is required for `table`/`tableRow` nodes — core CommonMark has no
// tables, so a bare remark-parse would count every article's tables as 0.
const processor = remark().use(remarkGfm);

function parseMd(md: string): Root {
  return processor.parse(md);
}

// Locale-aware sentence segmentation (UAX #29). Replaces the
// `/(?<=[.!?])\s+/` split. Measured behavior on Node/V8 (don't trust docs —
// verified 2026-06-11): abbreviations ("U.S.", "Dr.") STILL split — V8's "en"
// data ships no sentence-break suppressions, so this matches the old regex
// (parity, not regression); decimals ("$1.5 billion") are safe under both.
// The genuine wins: quote-trailing punctuation (`…hiring.” Then` is two
// sentences — the regex needed whitespace directly after [.!?] and merged
// them) and newlines as mandatory breaks (an unpunctuated heading line is its
// own segment instead of merging into the next sentence — fewer false merges
// for the em-dash counters).
const SENTENCE_SEGMENTER = new Intl.Segmenter("en", {
  granularity: "sentence",
});

/** Split text into trimmed, non-empty sentences. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const seg of SENTENCE_SEGMENTER.segment(text)) {
    const s = seg.segment.trim();
    if (s) out.push(s);
  }
  return out;
}

/** A relative markdown link with its exact source span. */
export interface RelativeLink {
  /** The link text EXACTLY as written in the source (inner markdown intact). */
  text: string;
  /** The link destination as parsed (always starts with "/"). */
  url: string;
  /** Byte offsets of the whole `[text](url)` span in the source string. */
  position: { start: number; end: number };
}

/**
 * Every relative link (`[text](/path…)`) in document order, via mdast `link`
 * nodes. Replaces RELATIVE_LINK_RE scanning. Deliberate deltas vs the regex,
 * all truer to what actually renders:
 * - links inside fenced/inline code are NOT links and are no longer matched
 *   (the regex mutated code spans);
 * - nested-bracket text (`[see [docs]](/x)`) parses as ONE link (the regex
 *   couldn't match it at all, leaving it unvalidated);
 * - image nodes (`![alt](/x)`) are skipped — the regex matched their tail and
 *   an unwrap would have left a stray `!` behind;
 * - `text` is the raw source slice between the brackets, byte-identical to
 *   what the regex captured, so unwrap/rewrite preserves inner formatting.
 */
export function extractRelativeLinks(md: string): RelativeLink[] {
  const links: RelativeLink[] = [];
  visit(parseMd(md), "link", (node: Link) => {
    if (!node.url.startsWith("/")) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      // remark-parse always emits positions; anything else is a parser bug we
      // must hear about, not silently skip (a skipped link dodges the gate).
      throw new Error(
        `extractRelativeLinks: link node missing position (url=${node.url})`,
      );
    }
    // .at() (not [i]) so the empty-children case (`[](/x)`) types as
    // `| undefined` — the optional chains below are load-bearing at runtime
    // and must not look "unnecessary" to the typed-lint autofixer.
    const first = node.children.at(0);
    const last = node.children.at(-1);
    const text =
      first?.position?.start.offset !== undefined &&
      last?.position?.end.offset !== undefined
        ? md.slice(first.position.start.offset, last.position.end.offset)
        : ""; // `[](/x)` — empty link text, same as the regex's `([^\]]*)`
    links.push({ text, url: node.url, position: { start, end } });
  });
  return links;
}

/** Count headings of exactly `depth`. Replaces `^#{depth}\s` line counting
 * (which also miscounted `#` lines inside code fences — the AST doesn't). */
export function countHeadings(md: string, depth: Heading["depth"]): number {
  let n = 0;
  visit(parseMd(md), "heading", (node: Heading) => {
    if (node.depth === depth) n += 1;
  });
  return n;
}

/**
 * True when a depth-1 heading exists AFTER the document's first node — i.e.
 * an H1 that is not a document-leading title. A leading H1 is the draft-shape
 * title; any later H1 is in-body. NOTE: generate.ts's pre-persist assertion
 * deliberately uses `countHeadings(final, 1) > 0` instead — post-title-strip,
 * a LEADING H1 is also a failure (a sanitizer can promote a reintroduced H1
 * to position 0), so the lead-exempting form would weaken that gate.
 */
export function hasInBodyH1(md: string): boolean {
  const tree = parseMd(md);
  let count = 0;
  visit(tree, "heading", (node: Heading) => {
    if (node.depth === 1) count += 1;
  });
  if (count === 0) return false;
  const firstNode = tree.children.at(0);
  const leadIsH1 = firstNode?.type === "heading" && firstNode.depth === 1;
  return leadIsH1 ? count > 1 : true;
}

/**
 * Total table rows (header + body) across all GFM tables. Replaces `^\|` line
 * counting with two deliberate deltas: the `|---|` delimiter line is not a row
 * (it never rendered as one), and tables written WITHOUT leading pipes
 * (`a | b` — valid GFM) are now counted instead of silently missed (a class
 * of the table-fix "silent no-op" false readings).
 */
export function tableRowCount(md: string): number {
  let n = 0;
  visit(parseMd(md), "tableRow", () => {
    n += 1;
  });
  return n;
}

/**
 * Parse a US-style long date ("April 21, 2026" / "April 21 2026") into a local
 * Date, or null. Replaces `new Date(\`${month} ${day}, ${year}\`)` — date-fns
 * `parse` is strict (rejects "April 99, 2026", which Date() rolls over).
 */
export function parseUsDate(s: string): Date | null {
  const normalized = s.trim().replace(/\s+/g, " ");
  for (const fmt of ["MMMM d, yyyy", "MMMM d yyyy"]) {
    const d = parseDateFns(normalized, fmt, new Date());
    if (isValid(d)) return d;
  }
  return null;
}

// A paired intra-sentence parenthetical: " — X — " where X carries no dash and
// no newline. The 3–80 char bound keeps this to genuine asides — anything
// longer is a clause that deserves a human rewrite, not a mechanical one.
const PAIRED_EMDASH_RE = / — ([^—\n]{3,80}?) — /g;
// Lines whose dashes must never be touched: table rows ("—" is the empty-cell
// marker), headings, and blockquotes (quoted speech is verbatim material).
const EMDASH_SKIP_LINE_RE = /^\s*(?:\||#{1,6}\s|>)/;

/** Is `index` inside an open quotation span on this line? Counts straight and
 * curly double quotes before the match — converting dashes inside quoted
 * speech would alter a quote, which is banned material. */
function inQuotedSpan(line: string, index: number): boolean {
  const before = line.slice(0, index);
  const straight = (before.match(/"/g) ?? []).length;
  const curlyOpen = (before.match(/“/g) ?? []).length;
  const curlyClose = (before.match(/”/g) ?? []).length;
  return straight % 2 === 1 || curlyOpen > curlyClose;
}

// ─── Numeric figures (round-8 redesign) ─────────────────────────────────────
// Numeric NORMALIZATION replaces the substring-needle equivalence classes that
// accreted in generate.ts's findUngroundedFigures over 10 review cycles
// (k-suffix, percent-ranges, magnitude-ranges, M/B roundings both directions,
// thousands-decimals, trailing zeros, comma forms — and still false-positived
// in 5 of 10 cycles, each fix opening the mirrored direction). Every figure on
// both sides parses to {value, unit}; grounding is value-equality within a
// small relative tolerance instead of a cross-product of surface forms. The
// incident regression matrix (R5C6/R5C7/R6C5/R6C8/R6C10/R7C1/R7C4/R7C5/R7C9/
// R7C10) lives in text.checks.ts, one labeled check per incident.

/** A numeric figure parsed from prose, normalized to value + unit. */
export interface Figure {
  /** The figure exactly as matched in the source text. */
  raw: string;
  /** Numeric value with magnitude applied ("$1.2M" → 1_200_000). */
  value: number;
  /** USD for $-figures, percent for %-figures, count for bare numbers. */
  unit: "USD" | "percent" | "count";
  /** Set on range endpoints — the value is one end of a stated band. */
  approx?: boolean;
}

/** A figure with its character offset in the source. Range co-occurrence
 * (synthesized-band detection) needs corpus positions, not just values. */
export interface FigureSpan {
  figure: Figure;
  start: number;
}

// "585.4 thousand" parses as 585_400; mn/bn/tn are the financial-press short
// forms ("$1.5bn") the letter class alone would miss.
const MAGNITUDES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  thousands: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  millions: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  billions: 1e9,
  t: 1e12,
  tn: 1e12,
  trillion: 1e12,
  trillions: 1e12,
};

function magnitudeOf(suffix: string): number {
  const key = suffix.toLowerCase().replace(/[()\s]/g, "");
  // Indexed read on a Record types as `number`; the miss case is real.
  const mult = (MAGNITUDES as Record<string, number | undefined>)[key];
  if (mult === undefined) {
    // A pattern/table mismatch is a programmer bug — surface it, never guess.
    throw new Error(`magnitudeOf: unrecognized magnitude suffix "${suffix}"`);
  }
  return mult;
}

function numberOf(digits: string): number {
  return Number(digits.replace(/,/g, ""));
}

/** digits × magnitude with float noise tidied (85.6 × 1000 → exactly 85600,
 * so the exact-equality fast path and integer-count rules stay reliable). */
function scaled(digits: string, mag: number): number {
  const v = numberOf(digits) * mag;
  return Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v;
}

// A number: digits with optional thousands-commas (structurally unable to end
// on a list-comma — the old gate needed a trailing-comma trim) and an optional
// decimal tail.
const NUM = String.raw`\d(?:[\d,]*\d)?(?:\.\d+)?`;
// Magnitude words, optionally pluralized; BLS table style parenthesizes them
// ("585.4 (thousands)" — R7C4). The lookahead rejects "millionaire".
const MAG_WORD = String.raw`(?:thousands?|millions?|billions?|trillions?)(?![A-Za-z])`;
const MAG_PAREN = String.raw`\(\s*(?:thousands?|millions?|billions?|trillions?)\s*\)`;
// Letter magnitudes incl. n-forms; lookahead rejects "25kg" / "25k4".
const MAG_LETTER = String.raw`[kmbt]n?(?![A-Za-z0-9])`;
// $-context magnitude tail: whitespace allowed before any form ("$272 K").
const MAG_USD = String.raw`(?:\s*(?:${MAG_PAREN}|${MAG_WORD}|${MAG_LETTER}))`;
// Bare-number magnitude tail: word forms may be spaced; the letter form must
// be ATTACHED ("22-25k") — a spaced bare letter is a unit of measure
// ("a 30 m tower"), not a magnitude.
const MAG_BARE = String.raw`(?:\s*(?:${MAG_PAREN}|${MAG_WORD})|${MAG_LETTER})`;
// Range separator: hyphen/en-dash (optionally spaced — both are range
// punctuation), an UNSPACED em-dash, or the words "to"/"through". A spaced
// em-dash is a clause break ("costs $5 — $10 is the ceiling"), never a band.
const SEP = String.raw`(?:\s*[-–]\s*|—|\s+(?:to|through)\s+)`;
const PCT = String.raw`(?:%|percent(?![A-Za-z]))`;
// Not preceded by a digit/decimal/comma (never start matching mid-number); the
// bare-number patterns also reject a leading $ (those spans are USD's).
const NO_NUM_BEFORE = String.raw`(?<![\d.,])`;
const NO_NUM_OR_USD_BEFORE = String.raw`(?<![\d.,$])`;

interface FigurePattern {
  re: RegExp;
  /** Figures for one match — [] vetoes the match (span stays unconsumed). */
  parse: (m: RegExpMatchArray) => Figure[];
}

// Priority-ordered: ranges before singles (a range subsumes its endpoints);
// the percent range leads so "$30-50%" resolves as a percent band, not a
// "$30-50" USD one. Overlapping later matches are dropped by the scanner.
const FIGURE_PATTERNS: FigurePattern[] = [
  {
    // Percent range — "30-50%", "30% to 50%", "22 to 25 percent". Both
    // endpoints carry the shared unit (R5C7: the low half never has its own
    // % sign and must not be groundable as a bare number).
    re: new RegExp(
      `${NO_NUM_BEFORE}(${NUM})\\s*%?${SEP}(${NUM})\\s*${PCT}`,
      "gi",
    ),
    parse: (m) => {
      // A plain-year low side is prose, not a band ("grew in 2026 to 50%
      // margins") — veto; the singles still extract both numbers.
      if (/^(?:19|20)\d{2}$/.test(m[1])) return [];
      return [
        { raw: m[0], value: numberOf(m[1]), unit: "percent", approx: true },
        { raw: m[0], value: numberOf(m[2]), unit: "percent", approx: true },
      ];
    },
  },
  {
    // USD range — "$160,000 to $340,000", "$500k-$1M+", "$30-50 million".
    re: new RegExp(
      `\\$(${NUM})(${MAG_USD})?${SEP}(\\$)?(${NUM})(${MAG_USD})?`,
      "gi",
    ),
    parse: (m) => {
      // Optional capture groups are undefined at runtime; .at() (not [i])
      // keeps that visible to the type system — the undefined checks below
      // are load-bearing and must not look "unnecessary" to the typed lint.
      const lowNum = m[1];
      const lowMag = m.at(2);
      const highDollar = m.at(3);
      const highNum = m[4];
      const highMag = m.at(5);
      // A $-less, magnitude-less, short high side is not a money endpoint
      // ("$3 million to 400 engineers") — veto; the singles still extract the
      // low side.
      if (
        highDollar === undefined &&
        highMag === undefined &&
        highNum.replace(/\D/g, "").length < 4
      ) {
        return [];
      }
      const hm = highMag === undefined ? 1 : magnitudeOf(highMag);
      // The low endpoint inherits the shared suffix (R6C8: "22-25k" means
      // 22,000) — but ONLY when it reads as a bare short number. A comma-
      // grouped or 4+-digit low side is already fully scaled ("$500,000 to
      // $1 million" must NOT become $500 billion — R8 smoke caught it live).
      const lowIsBare =
        !lowNum.includes(",") && lowNum.replace(/\D/g, "").length < 4;
      const lm =
        lowMag === undefined ? (lowIsBare ? hm : 1) : magnitudeOf(lowMag);
      return [
        { raw: m[0], value: scaled(lowNum, lm), unit: "USD", approx: true },
        { raw: m[0], value: scaled(highNum, hm), unit: "USD", approx: true },
      ];
    },
  },
  {
    // USD-WORD range — "305000–385000 USD/YEAR", "300,000 to 405,000 USD"
    // (boardTruth emits bare integers with a trailing USD word, no $ — the
    // R8 smoke flagged every real board band as a count↔USD unit mismatch).
    re: new RegExp(
      `(${NUM})(${MAG_USD})?${SEP}(${NUM})(${MAG_USD})?\\s*(?:USD|dollars)\\b`,
      "gi",
    ),
    parse: (m) => {
      const lowNum = m[1];
      const lowMag = m.at(2);
      const highNum = m[3];
      const highMag = m.at(4);
      const hm = highMag === undefined ? 1 : magnitudeOf(highMag);
      const lowIsBare =
        !lowNum.includes(",") && lowNum.replace(/\D/g, "").length < 4;
      const lm =
        lowMag === undefined ? (lowIsBare ? hm : 1) : magnitudeOf(lowMag);
      return [
        { raw: m[0], value: scaled(lowNum, lm), unit: "USD", approx: true },
        { raw: m[0], value: scaled(highNum, hm), unit: "USD", approx: true },
      ];
    },
  },
  {
    // USD-WORD single — "165000 USD", "85,566 dollars".
    re: new RegExp(`(${NUM})(${MAG_USD})?\\s*(?:USD|dollars)\\b`, "gi"),
    parse: (m) => {
      const mag = m.at(2);
      return [
        {
          raw: m[0],
          value: scaled(m[1], mag === undefined ? 1 : magnitudeOf(mag)),
          unit: "USD",
        },
      ];
    },
  },
  {
    // Bare magnitude range — "22-25k", "1.5 to 2 million" (counts).
    re: new RegExp(
      `${NO_NUM_OR_USD_BEFORE}(${NUM})(${MAG_BARE})?${SEP}(${NUM})(${MAG_BARE})`,
      "gi",
    ),
    parse: (m) => {
      const lowNum = m[1];
      const lowMag = m.at(2); // optional group — .at() keeps `| undefined`
      const highNum = m[3];
      const highMag = m[4];
      // A bare-year low side is prose, not a band ("grew in 2026 to 50
      // million users") — veto; the singles still extract both numbers.
      if (lowMag === undefined && /^(?:19|20)\d{2}$/.test(lowNum)) return [];
      const hm = magnitudeOf(highMag);
      // Same bare-short-low rule as the USD ranges (R8 smoke's $500B class):
      // "120,000 to 150 thousand" reads 120k→150k, not 120 BILLION→150k.
      const lowIsBare =
        !lowNum.includes(",") && lowNum.replace(/\D/g, "").length < 4;
      const lm =
        lowMag === undefined ? (lowIsBare ? hm : 1) : magnitudeOf(lowMag);
      return [
        { raw: m[0], value: scaled(lowNum, lm), unit: "count", approx: true },
        { raw: m[0], value: scaled(highNum, hm), unit: "count", approx: true },
      ];
    },
  },
  {
    // USD single — "$85,566", "$272K", "$1.23M", "$362.9 million", "$26.50".
    re: new RegExp(`\\$(${NUM})(${MAG_USD})?`, "gi"),
    parse: (m) => {
      const mag = m.at(2); // optional group — .at() keeps `| undefined`
      return [
        {
          raw: m[0],
          value: scaled(m[1], mag === undefined ? 1 : magnitudeOf(mag)),
          unit: "USD",
        },
      ];
    },
  },
  {
    // Percent single — "4.3%", "45 percent".
    re: new RegExp(`${NO_NUM_BEFORE}(${NUM})\\s*${PCT}`, "gi"),
    parse: (m) => [{ raw: m[0], value: numberOf(m[1]), unit: "percent" }],
  },
  {
    // Bare magnitude count — "585.4 thousand", "585.4 (thousands)", "25k".
    re: new RegExp(`${NO_NUM_OR_USD_BEFORE}(${NUM})(${MAG_BARE})`, "gi"),
    parse: (m) => {
      // Retirement-plan tokens, not counts: "401k" is not 401,000.
      if (/^40[13][kb]$/i.test(m[0].replace(/[\s,]/g, ""))) return [];
      return [
        { raw: m[0], value: scaled(m[1], magnitudeOf(m[2])), unit: "count" },
      ];
    },
  },
  {
    // Bare count — comma-grouped ("585,400") or 4+ plain digits, which keeps
    // years checked (R7C1: a fabricated "2029" must need a corpus "2029").
    re: /\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b/g,
    parse: (m) => [{ raw: m[0], value: numberOf(m[0]), unit: "count" }],
  },
];

/**
 * Every numeric figure in `text` with its character offset, in document
 * order. Ranges yield BOTH endpoint figures (same raw + start, approx: true).
 * Patterns run in priority order; a match overlapping an earlier-accepted
 * span is dropped, so a figure is parsed exactly once.
 */
export function extractFigureSpans(text: string): FigureSpan[] {
  // Accepted spans kept sorted by start; binary search finds the first span
  // ending after a candidate's start — the only one that could overlap it.
  const accepted: { start: number; end: number }[] = [];
  const overlapsAccepted = (s: number, e: number): boolean => {
    let lo = 0;
    let hi = accepted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (accepted[mid].end > s) hi = mid;
      else lo = mid + 1;
    }
    return lo < accepted.length && accepted[lo].start < e;
  };
  const insertAccepted = (s: number, e: number): void => {
    let lo = 0;
    let hi = accepted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (accepted[mid].start < s) lo = mid + 1;
      else hi = mid;
    }
    accepted.splice(lo, 0, { start: s, end: e });
  };
  const spans: FigureSpan[] = [];
  for (const { re, parse } of FIGURE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlapsAccepted(start, end)) continue;
      const figures = parse(m);
      if (figures.length === 0) continue;
      insertAccepted(start, end);
      for (const figure of figures) spans.push({ figure, start });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/** Every numeric figure in `text`, in document order (see extractFigureSpans). */
export function extractFigures(text: string): Figure[] {
  return extractFigureSpans(text).map((s) => s.figure);
}

// ±0.5% relative tolerance: wide enough for press roundings ("$85.6K" of an
// exact "$85,566"; "$362.9 million" of "$362,974,500"), far too narrow for a
// different figure to slip through ("$1.2 trillion" vs a corpus "$1.5T").
const FIGURE_REL_TOLERANCE = 0.005;

/**
 * Is `fig` supported by any corpus figure? Same unit AND value within ±0.5%
 * relative tolerance — exact for years (1900-2099: "2029" must never ground
 * on "2019" — R7C1) and for small integer counts (< 1000), where tolerance
 * is meaningless. USD matches USD regardless of surface form; a bare count
 * never grounds a dollar figure (R5C7/R7C9).
 */
export function figureGrounded(fig: Figure, corpusFigures: Figure[]): boolean {
  const exactOnly =
    fig.unit === "count" &&
    Number.isInteger(fig.value) &&
    (fig.value < 1000 || (fig.value >= 1900 && fig.value <= 2099));
  for (const c of corpusFigures) {
    if (c.unit !== fig.unit) continue;
    if (c.value === fig.value) return true;
    if (exactOnly) continue;
    const denom = Math.max(Math.abs(fig.value), Math.abs(c.value));
    if (
      denom > 0 &&
      Math.abs(c.value - fig.value) / denom <= FIGURE_REL_TOLERANCE
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Raw strings of `article` figures with no grounded corpus counterpart,
 * dedup'd, in first-appearance order. The pure core of generate.ts's
 * findUngroundedFigures (which adds per-corpus caching).
 *
 * Rules beyond per-figure grounding:
 * - bare-small skip: a 1-digit, magnitude-free figure ("$5", "9%") is below
 *   signal and never checked (pre-redesign parity);
 * - a USD RANGE is grounded only when its two endpoint values CO-OCCUR within
 *   `usdRangeWindowChars` of each other somewhere in the corpus — endpoints
 *   merely existing in unrelated places is exactly how synthesized salary
 *   bands shipped (R7C9); other ranges need every endpoint grounded.
 */
export function findUngroundedFigureRaws(
  article: string,
  corpusSpans: FigureSpan[],
  usdRangeWindowChars: number,
): string[] {
  const corpusFigures = corpusSpans.map((s) => s.figure);
  const byRaw = new Map<string, Figure[]>();
  for (const f of extractFigures(article)) {
    const list = byRaw.get(f.raw);
    if (list === undefined) byRaw.set(f.raw, [f]);
    else list.push(f);
  }
  const unmatched: string[] = [];
  for (const [raw, figs] of byRaw) {
    const digits = raw.replace(/\D/g, "").length;
    const hasMagnitude =
      /(?:[kmbt]n?|(?:thousand|million|billion|trillion)s?\)?)$/i.test(
        raw.trim(),
      );
    if (digits < 2 && !hasMagnitude) continue;
    // The same surface form can appear many times — judge distinct values.
    const uniq = figs.filter(
      (f, i) =>
        figs.findIndex((g) => g.value === f.value && g.unit === f.unit) === i,
    );
    const isUsdRange =
      uniq.length === 2 &&
      uniq.every((f) => f.unit === "USD" && f.approx === true);
    if (isUsdRange) {
      const lowPos: number[] = [];
      const highPos: number[] = [];
      for (const s of corpusSpans) {
        if (s.figure.unit !== "USD") continue;
        if (figureGrounded(uniq[0], [s.figure])) lowPos.push(s.start);
        if (figureGrounded(uniq[1], [s.figure])) highPos.push(s.start);
      }
      const cooccurs = lowPos.some((a) =>
        highPos.some((b) => Math.abs(a - b) <= usdRangeWindowChars),
      );
      if (!cooccurs) unmatched.push(raw);
    } else if (!uniq.every((f) => figureGrounded(f, corpusFigures))) {
      unmatched.push(raw);
    }
  }
  return unmatched;
}

// A clause span: lazy text up to a sentence-punctuation run ([.!?;:]+) that is
// followed by optional closers and whitespace/EOL (trailing space consumed), or
// the line's punctuation-less tail. The space/EOL requirement keeps decimals
// ("$1.5 billion") and "25.000-style" tokens inside ONE clause — a boundary
// inside a number would re-create the mid-sentence-surgery risk class. The two
// alternatives jointly match any non-empty position, so consecutive matches
// concatenate back to the original line exactly.
const CLAUSE_SPAN_RE = /.*?[.!?;:]+["”’)\]]*(?:\s+|$)|.+$/g;

/**
 * Repeated-CLAUSE backstop (round-8 item #4 — R7C9: a verbatim award-triplet
 * shipped twice after a no-op pass-1 repetition fix; dropDuplicateSentences
 * missed it because each copy lived inside a DIFFERENT sentence). Drops the
 * LATER occurrence of any clause whose normalized text is ≥ minChars and was
 * already seen — a clause being a span bounded by sentence punctuation
 * ([.!?;:]) or line boundaries, so only whole punctuation-bounded spans are
 * ever removed: never mid-sentence surgery, by construction. Skips headings,
 * tables, blockquotes, images, and rules (same structural guard as the
 * sentence dedup); a dangling mid-sentence connector left at a line's end by
 * a final-clause drop is closed to a period.
 */
export function dropRepeatedClauses(
  text: string,
  minChars: number,
): { text: string; dropped: number } {
  const seen = new Set<string>();
  let dropped = 0;
  const out = text.split("\n").map((line) => {
    if (/^\s*(#|\||>|!|-{3,})/.test(line) || !line.trim()) return line;
    const clauses = line.match(CLAUSE_SPAN_RE) ?? [];
    const kept = clauses.filter((clause) => {
      const norm = clause
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (norm.length < minChars) return true;
      if (seen.has(norm)) {
        dropped += 1;
        return false;
      }
      seen.add(norm);
      return true;
    });
    if (kept.length === clauses.length) return line; // untouched → byte-identical
    if (kept.length === 0) return "";
    return kept
      .join("")
      .replace(/[;:]\s*$/, ".")
      .trimEnd();
  });
  return { text: out.join("\n"), dropped };
}

/**
 * Cosine similarity between two equal-length vectors — the similarity
 * primitive for the embedding meaning-cousin dedup (round-8 #8). Pure math,
 * no I/O (the vectors come from src/lib/embedding.ts in generate.ts); kept
 * here so the checks suite can pin its behavior with synthetic vectors.
 * Throws on length mismatch, empty, or zero-magnitude input — a degenerate
 * vector means the embedding service misbehaved; surfacing beats a silent 0.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    throw new Error("cosineSimilarity: zero-magnitude vector");
  }
  return dot / denom;
}

/**
 * Deterministic em-dash reducer of last resort: converts PAIRED parenthetical
 * dashes ` — X — ` to ` (X) `, right-to-left (the late, afterthought asides go
 * first; the piece's opening dashes survive longest), until at most `cap`
 * em-dashes remain. Each conversion removes exactly two dashes. PAIRS ONLY —
 * a prior pass that deleted a single dash broke a sentence mid-clause; that
 * risk class is banned, so unpaired dashes are never touched. Table lines,
 * headings, blockquotes, and quoted spans are never modified.
 */
export function convertPairedEmdashParentheticals(
  text: string,
  cap: number,
): { text: string; converted: number } {
  const countDashes = (s: string): number => (s.match(/—/g) ?? []).length;
  let total = countDashes(text);
  if (total <= cap) return { text, converted: 0 };
  const lines = text.split("\n");
  let converted = 0;
  for (let i = lines.length - 1; i >= 0 && total > cap; i--) {
    if (EMDASH_SKIP_LINE_RE.test(lines[i])) continue;
    // Repeatedly convert the line's LAST eligible pair; matches are re-found
    // after each splice so shifted offsets and adjacent pairs stay correct.
    for (;;) {
      if (total <= cap) break;
      let last: { index: number; full: string; inner: string } | null = null;
      for (const m of lines[i].matchAll(PAIRED_EMDASH_RE)) {
        if (inQuotedSpan(lines[i], m.index)) continue;
        last = { index: m.index, full: m[0], inner: m[1] };
      }
      if (!last) break;
      lines[i] =
        lines[i].slice(0, last.index) +
        ` (${last.inner}) ` +
        lines[i].slice(last.index + last.full.length);
      converted += 1;
      total -= 2;
    }
  }
  return { text: lines.join("\n"), converted };
}
