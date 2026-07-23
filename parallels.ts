/**
 * Historical parallels: gemma PROPOSES (schema-constrained — it never free-
 * writes structure), Wikipedia's official keyless REST API VERIFIES (opensearch
 * → page summary; no SearXNG/VPS in the core path), and a mechanical token-
 * overlap score SELECTS. None survive → null — the Analysis says so honestly
 * instead of fabricating (the exact failure this design exists to prevent:
 * a live run once dated the Suez Crisis to 1967).
 */
import { z } from "zod";
import type { LlmClient } from "./ports";

export const ParallelCandidate = z.object({
  era: z.string().min(2),
  event: z.string().min(3),
  actors: z.array(z.string().min(2)).min(1).max(6),
  claimedSimilarity: z.string().min(10),
});
export type ParallelCandidate = z.infer<typeof ParallelCandidate>;

export interface VerifiedParallel extends ParallelCandidate {
  wikipediaTitle: string;
  wikipediaUrl: string;
  extract: string;
  score: number;
}

export async function proposeParallels(args: {
  llm: LlmClient;
  storySummary: string;
  count: number;
  model?: string;
  /** Verified encyclopedia text from a failed round — the re-propose prompt
   *  tells the model its memory conflicted and THIS record wins. */
  correctiveContext?: string;
}): Promise<ParallelCandidate[]> {
  const result = await args.llm.completeStructured({
    messages: [
      {
        role: "system",
        content:
          "You are a careful historian. Propose historical parallels for a current news story: real, well-documented events from any era whose DYNAMICS resemble the story. Use only widely known events with standard Wikipedia articles. Never invent events.",
      },
      {
        role: "user",
        content: `STORY:\n${args.storySummary}\n\nPropose exactly ${args.count} candidate parallels. For each: era (the year or period, e.g. "1956"), event (the standard name, e.g. "Suez Crisis"), actors (1-6 principal parties), claimedSimilarity (one sentence: which dynamic matches).${args.correctiveContext === undefined ? "" : `\n\nYOUR PREVIOUS CANDIDATES FAILED VERIFICATION — your memory of at least one event conflicted with the historical record. The verified record says:\n${args.correctiveContext}\nRe-propose candidates whose era, actors, and facts MATCH documented history; the record always wins over your memory.`}`,
      },
    ],
    schema: z.object({ candidates: z.array(ParallelCandidate).min(1).max(args.count) }),
    schemaName: "parallel_candidates",
    ...(args.model === undefined ? {} : { model: args.model }),
    temperature: 0.4,
  });
  return result.candidates;
}

const WIKI_OPENSEARCH = "https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&search=";
const WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/";

/** Significant-token overlap between the candidate's identity (event + actors
 *  + era) and the Wikipedia extract — mechanical, no LLM judging. */
function overlapScore(candidate: ParallelCandidate, extract: string): number {
  const hay = extract.toLowerCase();
  const tokens = [
    ...candidate.event.toLowerCase().split(/\W+/),
    ...candidate.actors.flatMap((a) => a.toLowerCase().split(/\W+/)),
    ...candidate.era.toLowerCase().split(/\W+/),
  ].filter((t) => t.length > 3 || /^\d{3,4}$/.test(t));
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((t) => hay.includes(t));
  return matched.length / tokens.length;
}

export async function verifyParallel(args: {
  candidate: ParallelCandidate;
  fetchImpl?: typeof fetch;
}): Promise<VerifiedParallel | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const searchRes = await fetchImpl(
    `${WIKI_OPENSEARCH}${encodeURIComponent(args.candidate.event)}`,
    { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "ai-journalist/news-desk (parallel verification)" } },
  );
  if (!searchRes.ok) {
    throw new Error(`parallels: opensearch HTTP ${searchRes.status} for "${args.candidate.event}"`);
  }
  const [, titles] = (await searchRes.json()) as [string, string[], string[], string[]];
  const title = titles[0];
  if (title === undefined || title === "") return null;

  const summaryRes = await fetchImpl(`${WIKI_SUMMARY}${encodeURIComponent(title)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "ai-journalist/news-desk (parallel verification)" },
  });
  if (!summaryRes.ok) {
    throw new Error(`parallels: summary HTTP ${summaryRes.status} for "${title}"`);
  }
  const summary = (await summaryRes.json()) as {
    title: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  };
  const extract = summary.extract ?? "";
  return {
    ...args.candidate,
    wikipediaTitle: summary.title,
    wikipediaUrl: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    extract,
    score: overlapScore(args.candidate, extract),
  };
}

export async function selectParallel(args: {
  candidates: ParallelCandidate[];
  minScore: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}): Promise<VerifiedParallel | null> {
  let best: VerifiedParallel | null = null;
  for (const candidate of args.candidates) {
    try {
      const verified = await verifyParallel({ candidate, ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }) });
      if (verified === null) {
        args.log?.(`parallels: no Wikipedia article found for "${candidate.event}" — dropped`);
        continue;
      }
      args.log?.(`parallels: "${candidate.event}" → ${verified.wikipediaTitle} (score ${verified.score.toFixed(2)})`);
      if (verified.score >= args.minScore && (best === null || verified.score > best.score)) {
        best = verified;
      }
    } catch (err: unknown) {
      args.log?.(`parallels: verification FAILED for "${candidate.event}": ${String(err)} — dropped`);
    }
  }
  return best;
}
