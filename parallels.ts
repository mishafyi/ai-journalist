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
import { readRules } from "./rules";

const PRECEDENT_RULES = readRules("precedents");

// SHAPE only — no length bounds, not even `.min(1)`. Zod rejects the whole
// object when any one element misses, and these call sites are NOT wrapped, so
// one empty actor string in one candidate ended the entire run: 15 runs to
// 2026-09-08 on the old `event.min(3)`-style bounds, then 17 more by 09-24 on
// `.min(1)`. Emptiness is a preference, applied by `shapeCandidates` after the
// parse, which drops the empty string or the candidate and keeps the rest.
export const ParallelCandidate = z.object({
  era: z.string(),
  event: z.string(),
  actors: z.array(z.string()),
  claimedSimilarity: z.string(),
});

/** Drop candidates too empty to research, cap the actor list, keep the rest. */
export function shapeCandidates(candidates: readonly ParallelCandidate[]): ParallelCandidate[] {
  return candidates
    .filter((c) => c.event.trim() !== "" && c.era.trim() !== "" && c.claimedSimilarity.trim() !== "")
    .map((c) => ({ ...c, actors: c.actors.filter((a) => a.trim() !== "").slice(0, 6) }));
}
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
  /** The events a first round proposed that scored poorly or failed
   *  verification — the re-propose names none of them. */
  rejected?: readonly string[];
  /** Bound proposals to recent history: subjects from roughly the past N
   *  years — an earlier act by a person at the centre of the story, an
   *  earlier chapter of the same relationship, a comparable recent event
   *  (the news-desk echo round passes 20). Omitted = any era. */
  windowYears?: number;
}): Promise<ParallelCandidate[]> {
  const result = await args.llm.completeStructured({
    messages: [
      { role: "system", content: `You are a careful historian.\n\nRULES:\n${PRECEDENT_RULES}` },
      {
        role: "user",
        content: `STORY:\n${args.storySummary}\n\nCOUNT: ${args.count}\nWINDOW: ${args.windowYears === undefined ? "any era" : `the past ${args.windowYears} years only`}${args.rejected === undefined || args.rejected.length === 0 ? "" : `\n\nREJECTED: ${args.rejected.join("; ")}`}`,
      },
    ],
    schema: z.object({ candidates: z.array(ParallelCandidate).min(1) }),
    // The echo round is its own step in the trace.
    schemaName: args.windowYears === undefined ? "parallel_candidates" : "echo_candidates",
    ...(args.model === undefined ? {} : { model: args.model }),
    temperature: 0.4,
  });
  return shapeCandidates(result.candidates).slice(0, args.count);
}

const WIKI_OPENSEARCH = "https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&search=";
const WIKI_FULLTEXT = "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=";
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
  let title = titles[0];
  if (title === undefined || title === "") {
    // opensearch is a PREFIX matcher: "Rwandan Genocide and Aftermath" finds
    // nothing while fulltext search resolves it to "Rwandan genocide"
    // (dropped every wordy-but-real candidate in production, 2026-07-26).
    const ftRes = await fetchImpl(`${WIKI_FULLTEXT}${encodeURIComponent(args.candidate.event)}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "ai-journalist/news-desk (parallel verification)" },
    });
    if (!ftRes.ok) {
      throw new Error(`parallels: fulltext search HTTP ${ftRes.status} for "${args.candidate.event}"`);
    }
    const ft = (await ftRes.json()) as { query?: { search?: { title?: string }[] } };
    title = ft.query?.search?.[0]?.title ?? "";
  }
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
