/**
 * `Embedder` port on the Gemini embedding endpoint, for the same job
 * `ollama-embedder.ts` does: headline matching for source resolution.
 *
 * It exists so the desk is not half-cloud. With `DESK_LLM=gemini` the prose
 * runs on Google and the embeddings still ran on the mini, which made the
 * local Ollama a hard dependency of a run that otherwise needed nothing local.
 *
 * The rotation, the cooldowns and the failure classification are NOT repeated
 * here — `createRotation` from `./gemini-llm` is the same ring of keys, the
 * same per-model-and-key cooldowns and the same hard-won reading of 429 / 503 /
 * 500 / 401 / dropped socket. SDK `retryOptions` (`SERVER_ERROR_RETRY`) retry
 * a 500/502/504 on the same key; a 429 rotates. There is no trigram fallback.
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
 * FREE TIER IS PER PROJECT AND PER MODEL, AND COUNTS EVERY TEXT (measured
 * 2026-09-19): 100 embeddings a minute and 1,000 a day, where a 100-text
 * batch is 100 of them (quota `EmbedContentRequestsPerMinutePerProjectPerModel
 * -FreeTier`, limit 100). Batching saves round trips, not quota. With 8 keys,
 * one model is 8,000 texts a day. A run embeds the outlet index (~1,000) plus
 * probes; the covered-check is a Gemma call, not an embedding. Each MODEL has
 * its own quota, so a second model doubles the day (operator, 2026-09-19:
 * "use second model").
 *
 * ONE MODEL PER CALL. Two models' vectors live in different spaces and never
 * meet: a call that runs out on one model starts again from its first text on
 * the next, `space` names the model in use, and the matcher's cache keys every
 * vector by it (matching.ts).
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
import { createRotation, GeminiExhausted, SERVER_ERROR_RETRY } from "./gemini-llm";

/**
 * Texts per request. The API's own ceiling, not a guess — see the header.
 * Above it the endpoint answers 400 and the rotation rethrows at once.
 */
const BATCH = 100;

/** Native width is 3,072; 768 is the truncation the header defends. */
const DIMENSIONS = 768;

/** The embedding models, in order: each has its own daily quota per project. */
export const EMBED_MODELS: readonly string[] = ["gemini-embedding-2", "gemini-embedding-001"];

export interface GeminiEmbedderConfig {
  /** The ring. Free-tier limits are per PROJECT, so keys help only when they
   *  come from different projects — see `createGeminiLlm`'s note. */
  apiKeys: readonly string[];
  /** Tried in order; the next takes over, for the rest of the run, once one
   *  is spent on every key. */
  models: readonly string[];
  /** Where a rotation announces itself; silent when absent. */
  log?: (line: string) => void;
}

export function createGeminiEmbedder(cfg: GeminiEmbedderConfig): Embedder {
  if (cfg.models.length === 0) throw new Error("gemini embed: no models configured");
  const ring = cfg.apiKeys.map((apiKey) => new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 120_000, retryOptions: SERVER_ERROR_RETRY },
  }));
  const rotate = createRotation(cfg.models, ring.length, cfg.log);
  let current = 0;

  async function embedChunk(model: string, texts: readonly string[]): Promise<number[][]> {
    // A string[] here would be WRONG and silently so: the SDK folds it into
    // ONE content of many parts and returns a single vector for the lot
    // (measured — 250 texts came back as 1 embedding, no error). One Content
    // per text is what makes it a batch.
    const contents = texts.map((text) => ({ parts: [{ text }] }));
    return await rotate("embed", model, async (m, keyIndex) => {
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
    /** The model in use: vectors from two models are never compared. */
    get space(): string {
      return cfg.models[current] as string;
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      for (;;) {
        const model = cfg.models[current] as string;
        try {
          const out: number[][] = [];
          // Sequential: the rotation moves to the next key per call, so this
          // spreads the load across projects on its own. Firing them in parallel
          // would only race the same per-minute budgets into 429s.
          for (let i = 0; i < texts.length; i += BATCH) {
            out.push(...(await embedChunk(model, texts.slice(i, i + BATCH))));
          }
          return out;
        } catch (err: unknown) {
          if (!(err instanceof GeminiExhausted) || current === cfg.models.length - 1) throw err;
          current += 1;
          cfg.log?.(`gemini: embed — ${model} is spent on every key; ${cfg.models[current]} embeds the rest of the run, starting this call again`);
        }
      }
    },
  };
}
