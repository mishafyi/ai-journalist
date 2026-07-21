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

async function embedScores(
  embedder: Embedder,
  probes: readonly string[],
  candidates: readonly string[],
): Promise<number[]> {
  const vecs = await embedder.embed([...probes, ...candidates]);
  const probeVecs = vecs.slice(0, probes.length);
  const candVecs = vecs.slice(probes.length);
  return candVecs.map((cv) => Math.max(...probeVecs.map((pv) => cosineSimilarity(pv, cv))));
}

export function createHeadlineMatcher(opts: { embedder?: Embedder }): HeadlineMatcher {
  const scoresFor = (probes: readonly string[], candidates: readonly string[]): Promise<number[]> =>
    opts.embedder ? embedScores(opts.embedder, probes, candidates) : Promise.resolve(trigramScores(probes, candidates));

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
