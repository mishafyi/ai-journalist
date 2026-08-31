/**
 * claim-check.ts — the SECOND job for a general web search.
 *
 * Web search stopped being a source-discovery channel on 2026-08-16: it
 * admitted any host it returned, which is how an impersonator got cited
 * (see sources/provenance.ts). Discovery is Google News now. But an open
 * search is still the right tool for the opposite question — "does anyone
 * else report this?" — so it moves here, downstream of writing, where a wrong
 * host cannot become a citation because nothing here is ever cited.
 *
 * The desk extracts the column's most checkable factual claims, searches each,
 * and reports whether independent, non-deny-tier hosts appear to corroborate.
 * Informational and non-blocking by contract, exactly like the fact-check
 * audit: a claim nobody corroborates is a flag for the run log and the
 * provenance artifact, not a publish-blocker — search silence is not
 * falsehood, and blocking on it would gut the paper on legitimate scoops.
 */
import { z } from "zod";
import type { LlmClient, SearchClient } from "./ports";
import { provenanceOf } from "./sources/provenance";

export interface CheckedClaim {
  claim: string;
  /** Distinct non-deny hosts whose result text overlaps the claim's terms. */
  corroborating: string[];
  /** True when at least one independent host appears to back the claim. */
  corroborated: boolean;
}

/** Content words shared between a claim and a result blurb, as a fraction of
 *  the claim's own. Deliberately crude: this ranks plausibility for a human
 *  reading the log, it does not adjudicate truth. */
export function termOverlap(claim: string, text: string): number {
  const words = (t: string): Set<string> =>
    new Set(
      t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3),
    );
  const a = words(claim);
  const b = words(text);
  if (a.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / a.size;
}

/** Above this, a search result reads as talking about the same fact. */
export const CORROBORATION_OVERLAP = 0.34;

const ClaimsSchema = z.object({
  claims: z.array(z.string().min(20).max(240)).min(1).max(6),
});

/**
 * Pull the column's checkable claims and look for independent corroboration.
 * Best-effort: any failure returns [] and the caller carries on.
 */
export async function checkClaims(args: {
  column: string;
  llm: LlmClient;
  search: SearchClient;
  /** Hosts the column already cites — corroboration must be INDEPENDENT. */
  citedHosts: readonly string[];
  max: number;
  /** The story's subject (e.g. its headline), appended to every search query —
   *  a subjectless claim would otherwise search blind. Retrieval only:
   *  overlap is still scored claim-vs-result, never query-vs-result. */
  subject?: string;
  log?: (line: string) => void;
}): Promise<CheckedClaim[]> {
  try {
    const extracted = await args.llm.completeStructured({
      messages: [
        {
          role: "system",
          content:
            "You extract checkable factual claims from a news column. A checkable claim is a specific, verifiable statement of fact — a number, a date, a named party doing a named thing. NEVER extract opinion, prediction, analysis or rhetorical questions. Quote each claim as one plain sentence, self-contained enough to search — which means each claim MUST explicitly name its subject, the person, organization or place it is about (\"Maduro's trial is set for June 2027\", never \"Legal proceedings are set for June 2027\"): a claim without its named subject cannot be searched and is worthless.",
        },
        { role: "user", content: args.column.slice(0, 6000) },
      ],
      schema: ClaimsSchema,
      schemaName: "checkable_claims",
      temperature: 0,
    });
    const held = new Set(args.citedHosts.map((h) => h.toLowerCase().replace(/^www\./, "")));
    const out: CheckedClaim[] = [];
    for (const claim of extracted.claims.slice(0, args.max)) {
      const query = args.subject === undefined || args.subject.trim() === "" ? claim : `${claim} ${args.subject}`;
      const results = await args.search.search(query, { limit: 6 });
      const corroborating = [
        ...new Set(
          results
            .filter((r) => r.url.startsWith("http"))
            .filter((r) => termOverlap(claim, `${r.title} ${r.snippet ?? ""}`) >= CORROBORATION_OVERLAP)
            .map((r) => {
              try {
                return new URL(r.url).hostname.toLowerCase().replace(/^www\./, "");
              } catch {
                return "";
              }
            })
            // Independent: not already cited, and never a deny-tier host —
            // a content farm agreeing with you is not corroboration.
            .filter((h) => h !== "" && !held.has(h) && provenanceOf(h) !== "deny"),
        ),
      ];
      out.push({ claim, corroborating, corroborated: corroborating.length > 0 });
    }
    const weak = out.filter((c) => !c.corroborated);
    if (weak.length > 0) {
      args.log?.(
        `claim-check: ${weak.length}/${out.length} claim(s) found no independent corroboration — ${weak
          .map((c) => `"${c.claim.slice(0, 60)}…"`)
          .join(", ")}`,
      );
    }
    return out;
  } catch (err: unknown) {
    args.log?.(`claim-check: skipped (best-effort): ${String(err)}`);
    return [];
  }
}
