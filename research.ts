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

/** Skip-host classification is REUSED from ./news (identical list + matcher
 *  already shipped there) and re-exported for one-import consumption. */
export { isBlockedHost, DEFAULT_BLOCKED_HOSTS } from "./news";

/** Class patterns, not an offender blocklist — ported with provenance from
 *  the production adapter (they classified where a name-list classified 0/20). */
export const DEFAULT_TIER1_RE =
  /(\.gov|\.edu|\.mil)$|(^|\.)(reuters|apnews|bloomberg|wsj|nytimes|washingtonpost|ft|theinformation|axios|cnbc|techcrunch|arstechnica|theverge|wired|ieee|nature|sciencemag|spacenews|aviationweek|defensenews|breakingdefense|globenewswire|businesswire|prnewswire|sec|mckinsey|deloitte|gartner|isg-one|burtchworks)\.(com|org|net)$/i;
export const DEFAULT_LOWTIER_RE =
  /course|staffing|recruit|career|jobdescription|jobright|salesfolk|interviewquery|unteachable|usbusinessnews|automateamerica|bestof|top10|insights?hub|guestpost/i;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export interface TierRes {
  tier1?: RegExp;
  low?: RegExp;
}

export function sourceTier(url: string, res?: TierRes): 1 | 2 | 3 {
  const host = hostOf(url);
  if ((res?.tier1 ?? DEFAULT_TIER1_RE).test(host)) return 1;
  if ((res?.low ?? DEFAULT_LOWTIER_RE).test(host)) return 3;
  return 2;
}
