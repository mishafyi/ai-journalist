/**
 * research.ts — the engine's hardened research stack, upstreamed from a
 * production adapter (query hygiene, source tiering, throttled search with
 * a dead-upstream breaker, primary-source chase, chunked extraction).
 * Port-pure: speaks only SearchClient/LlmClient; all knobs are arguments.
 * Everything here is OPT-IN — presets keep their cheap snippet default.
 */

const DOUBLE_QUOTES = /[„“”«»]/g;
const SINGLE_QUOTES = /[‚‘’‹›]/g;
const BOX_SCAFFOLD =
  /^\s*(?:history|scope|reasons|impacts|countermoves|futures)\s*:[^-]{0,60}-\s*/i;
const INTERROGATIVE_LEAD =
  /^(?:why|how|what|when|where|which|who|does|do|is|are|can|should|will)\s+/i;

/** Returns the cleaned query, or null when nothing searchable remains.
 *  Question-phrased queries are de-interrogated — search backends answer
 *  "why …" with dictionary definitions of "why". */
export function sanitizeQuery(query: string): string | null {
  const cleaned = query
    .replace(DOUBLE_QUOTES, '"')
    .replace(SINGLE_QUOTES, "'")
    .replace(BOX_SCAFFOLD, "")
    .trim();
  if (cleaned.length < 8) return null;
  if (/-\s*$/.test(cleaned)) return null; // trailing dash = empty query slot
  const stripped = cleaned
    .replace(INTERROGATIVE_LEAD, "")
    .replace(INTERROGATIVE_LEAD, "")
    .replace(/\?+\s*$/, "")
    .trim();
  return stripped.length >= 8 ? stripped : cleaned;
}

/** Progressively relax an over-constrained query: strip site:/intitle:/inurl:
 *  operators and -negations, then unquote phrases. Empty retries re-run the
 *  RELAXED form instead of repeating a dead query. */
export function relaxQuery(query: string): string {
  return query
    .replace(/\b(?:site|inurl):\S+/gi, " ")
    .replace(/\bintitle:/gi, "")
    .replace(/(^|\s)-(?:"[^"]*"|\S+)/g, " ")
    .replace(/"([^"]*)"/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
