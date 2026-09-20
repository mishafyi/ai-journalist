/**
 * matching.ts — mechanical headline similarity for the news desk. The model
 * never ranks: embeddings (Embedder port) when configured, trigrams only when
 * no embedder is passed. A live embedder that fails is a failed match — retry
 * and key rotation belong to the embedder, not a second scorer here.
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
  // Keyed by SPACE and text, not text alone. An embedder that fails over to a
  // second backend mid-run returns vectors from a different space, and a
  // cosine similarity across two spaces is arithmetic without meaning. Reading
  // `space` per call rather than once is the point: it changes when the
  // failover fires, and every prior entry simply misses and is re-embedded.
  const key = (text: string): string => `${embedder.space ?? ""}\n${text}`;
  return async function embedCached(texts: readonly string[]): Promise<number[][]> {
    for (;;) {
      const space = embedder.space;
      const missing = [...new Set(texts.filter((t) => !cache.has(key(t))))];
      if (missing.length > 0) {
        const fresh = await embedder.embed(missing);
        // The space moved DURING this call: the texts cached before it are
        // vectors of the old space, so the whole list is asked again in the new one.
        if (embedder.space !== space) continue;
        missing.forEach((t, i) => cache.set(key(t), fresh[i]));
      }
      // Non-null: every text is either cached or was just embedded, in one space.
      return texts.map((t) => cache.get(key(t)) as number[]);
    }
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

export function createHeadlineMatcher(opts: { embedder?: Embedder } = {}): HeadlineMatcher {
  const embed = opts.embedder ? createVectorCache(opts.embedder) : null;
  // Embeddings when an embedder is configured; trigrams when it is not.
  // There is no third mode. A spent ring, a 500, a dropped socket — those
  // retry and rotate inside the embedder. Catching them here to re-score
  // with trigrams made the 0.62 threshold mean two different things, and
  // published the same story twice.
  const scoresFor = async (probes: readonly string[], candidates: readonly string[]): Promise<number[]> => {
    if (embed === null) return trigramScores(probes, candidates);
    return embedScores(embed, probes, candidates);
  };

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
