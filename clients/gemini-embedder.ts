/**
 * `Embedder` port on the Gemini embedding endpoint, for the same job
 * `ollama-embedder.ts` does: headline matching and covered-story dedup.
 *
 * It exists so the desk is not half-cloud. With `DESK_LLM=gemini` the prose
 * runs on Google and the embeddings still ran on the mini, which made the
 * local Ollama a hard dependency of a run that otherwise needed nothing local.
 *
 * The rotation, the cooldowns and the failure classification are NOT repeated
 * here — `createRotation` from `./gemini-llm` is the same ring of keys, the
 * same per-model-and-key cooldowns and the same hard-won reading of 429 / 503 /
 * 500 / 401 / dropped socket. One classifier, one place to fix it.
 *
 * ── Measured against the live API, 2026-09-08 ──────────────────────────────
 *
 * MODELS (`models.list`): `gemini-embedding-2` (8,192 input tokens) and
 * `gemini-embedding-001` (2,048). Output is 3,072-dimensional.
 *
 * BATCH CEILING IS 100, and it is a hard one: 250 contents answers
 * `400 * BatchEmbedContentsRequest.requests: at most 100 requests can be in
 * one batch`. That is a 400, so the rotation correctly refuses to retry it —
 * a batch too large is our bug, not Google's weather. 100 texts embed in
 * ~1.3s.
 *
 * FREE TIER IS PER PROJECT (docs/gemini.md in the site repo): 100 RPM,
 * 30,000 TPM, 1,000 RPD. The ring holds 12 keys of which 8 answer, so the
 * paper's real budget is ~8,000 embed requests a day.
 *
 * WHY THAT IS ENOUGH, and why batching is not optional: the desk matches every
 * trending story against the whole outlet index, 1,000+ headlines, which at
 * one request per text would be 1,000 requests — an eighth of the day's total
 * budget for a single run, at a desk that runs every ~25 minutes. At 100 per
 * request the same index costs 10, and `matching.ts` caches vectors per run so
 * the index is embedded once per run rather than once per story: ~700 requests
 * a day against ~8,000. The 30K TPM cap is cleared the same way — a full index
 * is ~20K tokens, and the rotation advances a key per call, so ten batches
 * land on ten projects rather than stacking on one minute's budget.
 *
 * ── The one deliberate difference from the Ollama embedder ─────────────────
 *
 * `outputDimensionality: 768` truncates the native 3,072 to the width
 * `embeddinggemma` already returns, which is a quarter of the JSON to ship and
 * parse for every batch. Safe here specifically because the only consumer is
 * `cosineSimilarity`, which divides by both norms — Google's advice to
 * re-normalise a truncated embedding is for dot-product and L2 users. The two
 * embedders' vectors still never meet: the cache in `matching.ts` is created
 * per run and dies with it.
 */
import { GoogleGenAI } from "@google/genai";
import type { Embedder } from "../ports";
import { createRotation } from "./gemini-llm";

/**
 * Texts per request. The API's own ceiling, not a guess — see the header.
 * Above it the endpoint answers 400 and the rotation rethrows at once.
 */
const BATCH = 100;

/** Native width is 3,072; 768 is the truncation the header defends. */
const DIMENSIONS = 768;

export interface GeminiEmbedderConfig {
  /** The ring. Free-tier limits are per PROJECT, so keys help only when they
   *  come from different projects — see `createGeminiLlm`'s note. */
  apiKeys: readonly string[];
  /** Default `gemini-embedding-2`; `GEMINI_EMBED_MODEL` overrides. */
  model?: string;
  /** Where a rotation announces itself; silent when absent. */
  log?: (line: string) => void;
}

export function createGeminiEmbedder(cfg: GeminiEmbedderConfig): Embedder {
  const model = cfg.model ?? process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-2";
  const ring = cfg.apiKeys.map((apiKey) => new GoogleGenAI({ apiKey, httpOptions: { timeout: 120_000 } }));
  const rotate = createRotation([model], ring.length, cfg.log);

  async function embedChunk(texts: readonly string[]): Promise<number[][]> {
    // A string[] here would be WRONG and silently so: the SDK folds it into
    // ONE content of many parts and returns a single vector for the lot
    // (measured — 250 texts came back as 1 embedding, no error). One Content
    // per text is what makes it a batch.
    const contents = texts.map((text) => ({ parts: [{ text }] }));
    return await rotate("embed", undefined, async (m, keyIndex) => {
      const res = await ring[keyIndex].models.embedContent({
        model: m,
        contents,
        config: { outputDimensionality: DIMENSIONS },
      });
      const vectors = res.embeddings ?? [];
      if (vectors.length !== texts.length) {
        // A short list is a CONTENT failure: asking again verbatim returns the
        // same thing, so it must not go round the ring. Same reasoning as the
        // Ollama embedder's identical guard.
        throw new Error(
          `gemini embed returned ${vectors.length} vectors for ${texts.length} inputs (model=${m})`,
        );
      }
      return vectors.map((v, i) => {
        const values = v.values ?? [];
        if (values.length === 0) throw new Error(`gemini embed returned an empty vector at index ${i} (model=${m})`);
        return values;
      });
    }, 0);
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      // Sequential: the rotation moves to the next key per call, so this
      // spreads the load across projects on its own. Firing them in parallel
      // would only race the same per-minute budgets into 429s.
      for (let i = 0; i < texts.length; i += BATCH) {
        out.push(...(await embedChunk(texts.slice(i, i + BATCH))));
      }
      return out;
    },
  };
}
