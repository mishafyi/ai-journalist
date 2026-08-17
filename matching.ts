/**
 * matching.ts — mechanical headline similarity for the news desk. The model
 * never ranks: embeddings (Embedder port) when configured, trigram fallback
 * otherwise. Pure engine core; the embedder arrives through the port.
 */
import { cosineSimilarity } from "./text";
import { trigramSimilarity } from "./primitives";
import type { Embedder } from "./ports";

export interface MatchHit {
  index: number;
  score: number;
}

export interface HeadlineMatcher {
  match(probe: string, candidates: readonly string[], threshold: number): Promise<MatchHit | null>;
  matchAny(probes: readonly string[], candidates: readonly string[], threshold: number): Promise<MatchHit[]>;
}

function trigramScores(probes: readonly string[], candidates: readonly string[]): number[] {
  return candidates.map((c) => {
    const lc = c.toLowerCase();
    return Math.max(...probes.map((p) => trigramSimilarity(p.toLowerCase(), lc)));
  });
}

/**
 * Vector cache, keyed by the exact text.
 *
 * The desk matches every trending story against the SAME outlet index — one
 * run re-embedded those thousands of headlines once per story. With the feed
 * list grown past sixty papers that is the dominant cost of a run, and every
 * repeat is provably redundant: the index does not change mid-run and an
 * embedding is a pure function of its text. The matcher is created per run,
 * so the cache dies with it and can never serve a stale vector.
 */
function createVectorCache(embedder: Embedder) {
  const cache = new Map<string, number[]>();
  return async function embedCached(texts: readonly string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
    if (missing.length > 0) {
      const fresh = await embedder.embed(missing);
      missing.forEach((t, i) => cache.set(t, fresh[i]));
    }
    // Non-null: every text is either cached or was just embedded.
    return texts.map((t) => cache.get(t) as number[]);
  };
}

async function embedScores(
  embed: (texts: readonly string[]) => Promise<number[][]>,
  probes: readonly string[],
  candidates: readonly string[],
): Promise<number[]> {
  const vecs = await embed([...probes, ...candidates]);
  const probeVecs = vecs.slice(0, probes.length);
  const candVecs = vecs.slice(probes.length);
  return candVecs.map((cv) => Math.max(...probeVecs.map((pv) => cosineSimilarity(pv, cv))));
}

export function createHeadlineMatcher(opts: { embedder?: Embedder }): HeadlineMatcher {
  const embed = opts.embedder ? createVectorCache(opts.embedder) : null;
  const scoresFor = (probes: readonly string[], candidates: readonly string[]): Promise<number[]> =>
    embed ? embedScores(embed, probes, candidates) : Promise.resolve(trigramScores(probes, candidates));

  return {
    async match(probe, candidates, threshold): Promise<MatchHit | null> {
      if (candidates.length === 0) return null;
      const scores = await scoresFor([probe], candidates);
      let best = 0;
      for (let i = 1; i < scores.length; i += 1) if (scores[i] > scores[best]) best = i;
      return scores[best] >= threshold ? { index: best, score: scores[best] } : null;
    },
    async matchAny(probes, candidates, threshold): Promise<MatchHit[]> {
      if (probes.length === 0 || candidates.length === 0) return [];
      const scores = await scoresFor(probes, candidates);
      return scores
        .map((score, index) => ({ index, score }))
        .filter((h) => h.score >= threshold);
    },
  };
}
