/**
 * Zod schemas for the two structured LLM outputs in Phase 1 (discovery):
 *  - DiscoveryOutput: the query-gen step ({queries, companies}).
 *  - Plan: the story-pick step ({title, angle, sections:[{heading,intent,queries}]}).
 *
 * The pipeline already Zod-validates LLM JSON elsewhere; these mirror that.
 * parse* extract the first {...} block (LLM output may carry prose/fences) and
 * throw a clear, phase-tagged error on malformed/invalid output so the caller's
 * withRetry can retry the model.
 */
import { z } from "zod";

export const DiscoveryOutput = z.object({
  queries: z.array(z.string().min(3)).min(1),
  companies: z.array(z.string().min(1)).default([]),
});
export type DiscoveryOutput = z.infer<typeof DiscoveryOutput>;

export const PlanSection = z.object({
  heading: z.string().min(1),
  intent: z.string().min(1),
  queries: z.array(z.string().min(3)).default([]),
});
export type PlanSection = z.infer<typeof PlanSection>;

export const Plan = z.object({
  title: z.string().min(1),
  angle: z.string().min(1),
  // The story's primary domain — maps to a site industry for enrichment/links
  // (domainFor: robotics | artificial-intelligence | aerospace-engineering →
  // their industries, anything else → frontier). Optional: a missing/unknown
  // value resolves to "frontier" downstream.
  category: z.string().optional(),
  // A 2-4 word query a reader would type into Google to find this story
  // (e.g. "defense tech salaries") — grounds the headline pass's live
  // autocomplete lookup. Optional: falls back to the title's leading words.
  searchSeed: z.string().optional(),
  sections: z.array(PlanSection).min(1),
});
export type Plan = z.infer<typeof Plan>;

/** Replace raw control characters (code point < 0x20) with a space. owl-alpha
 *  occasionally emits a literal newline or tab INSIDE a JSON string value, which
 *  JSON.parse rejects ("Bad control character in string") and which crashed whole
 *  blog runs even though the structure was valid. Properly-escaped sequences are
 *  ordinary two-character text, so they are unaffected; inter-token whitespace
 *  becomes spaces (still valid JSON). Done without a regex to avoid embedding
 *  control characters / the no-control-regex lint. */
function stripControlChars(s: string): string {
  return Array.from(s, (ch) =>
    (ch.codePointAt(0) ?? 32) < 0x20 ? " " : ch,
  ).join("");
}

/** Extract the first {...} block from raw model text, or throw with `label`. */
export function extractJsonObject(raw: string, label: string): unknown {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`${label}: no JSON object in model output`);
  return JSON.parse(stripControlChars(m[0]));
}

/** Parse + validate the model's Plan JSON; throws on malformed/invalid. */
export function parsePlan(raw: string): Plan {
  return Plan.parse(extractJsonObject(raw, "plan"));
}

/** Parse + validate the model's DiscoveryOutput JSON; throws on malformed/invalid. */
export function parseDiscovery(raw: string): DiscoveryOutput {
  return DiscoveryOutput.parse(extractJsonObject(raw, "discovery"));
}
