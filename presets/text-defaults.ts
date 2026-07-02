/**
 * Generic, host-free implementations of the pure text/format helpers
 * `PipelineDeps` requires. A host with sharper domain-tuned versions overrides
 * them; `createDefaultInternals` (./default) binds these so the engine writes
 * out of the box. CORE module: pure functions, no env, no I/O.
 */
import { splitSentences } from "../text";

/** Meta-prose signature ("here are the checks…"). */
export const META_PROSE_RE =
  /\bhere (?:are|is) the (?:checks|changes|revisions|edits|updates)\b/i;
/** Chain-of-thought opener ("Let me identify…"). */
export const COT_PREFIX_RE =
  /^\s*(?:let me|first,? (?:i(?:'ll| will)?|let's)|i(?:'ll| will) (?:now )?(?:identify|analyze|review|go through))\b/i;
/** Explicit hand-off preamble line ("Here is the revised article:"). */
export const PREAMBLE_LINE_RE =
  /^\s*(?:sure[,!.]?\s*)?here(?:'s| is) (?:the|your|a) (?:revised|updated|edited|final|improved)?\s*(?:article|draft|version|text)\b.*$/im;

/**
 * Strip a surgical pass's hand-off preamble line and/or a whole-body code
 * fence. Identity on clean input.
 */
export function stripPreambleAndFence(text: string): string {
  let out = text;
  const fence = out.match(/^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/);
  if (fence) out = fence[1];
  const lines = out.split("\n");
  if (lines.length > 1 && PREAMBLE_LINE_RE.test(lines[0])) {
    out = lines.slice(1).join("\n").replace(/^\s*\n/, "");
  }
  return out.trim() === text.trim() ? text : out.trim();
}

/**
 * Is the candidate still article-shaped vs its reference? Generic rule: it
 * keeps at least half the reference's H2 count (min 1 when the reference has
 * any) and is not a single collapsed paragraph.
 */
export function isArticleShaped(candidate: string, reference: string): boolean {
  const count = (md: string): number =>
    md.split("\n").filter((l) => /^##\s/.test(l)).length;
  const ref = count(reference);
  if (ref === 0) return candidate.trim().length > 0;
  return count(candidate) >= Math.max(1, Math.ceil(ref / 2));
}

/** Keep a surgical fix only if it stayed 70–130% of the input's length. */
export function lengthSafe(
  label: string,
  input: string,
  output: string,
): string {
  const ratio = output.length / Math.max(1, input.length);
  return ratio >= 0.7 && ratio <= 1.3 ? output : input;
}

/** Count vague pay-banding phrases (generic phrase list). */
export function countVagueBanding(text: string): number {
  const patterns = [
    /\bcompetitive (?:salary|salaries|pay|compensation)\b/gi,
    /\bcommensurate with experience\b/gi,
    /\bmarket[- ]rate (?:pay|salary|compensation)\b/gi,
    /\bdepending on experience\b/gi,
  ];
  return patterns.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}

/** Delete later verbatim-duplicate sentences of at least `minChars`. */
export function dropDuplicateSentences(
  text: string,
  minChars: number,
): { text: string; dropped: number } {
  const seen = new Set<string>();
  let dropped = 0;
  const kept = splitSentences(text).filter((s) => {
    const key = s.trim();
    if (key.length < minChars) return true;
    if (seen.has(key)) {
      dropped += 1;
      return false;
    }
    seen.add(key);
    return true;
  });
  return { text: kept.join(" "), dropped };
}

/** Distinct word-shingles of `size` words appearing more than once. */
export function findRepeatedShingles(text: string, size: number): string[] {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
    .filter(Boolean);
  const seen = new Map<string, number>();
  for (let i = 0; i + size <= words.length; i += 1) {
    const sh = words.slice(i, i + size).join(" ");
    seen.set(sh, (seen.get(sh) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([sh]) => sh);
}

/** Context quotes (±`pad` chars) for each occurrence of a normalized shingle. */
export function shingleOccurrences(
  text: string,
  shingle: string,
  pad: number,
): string[] {
  const hay = text.toLowerCase();
  const needle = shingle.toLowerCase();
  const out: string[] = [];
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    out.push(
      text.slice(Math.max(0, idx - pad), idx + needle.length + pad),
    );
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return out;
}

/** Sentences carrying ≥3 em-dashes. */
export function emdashClusteredLines(text: string): number {
  return splitSentences(text).filter(
    (s) => (s.match(/—/g)?.length ?? 0) >= 3,
  ).length;
}
