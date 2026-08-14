/**
 * `Embedder` port via the OFFICIAL `ollama` npm client (headline matching,
 * covered-story dedup). Model of record: `embeddinggemma` — pull it on the
 * serving box (`ollama pull embeddinggemma`, ~622 MB).
 * clients/** is the sanctioned SDK tree; the engine consumes only the port.
 */
import { Ollama } from "ollama";
import type { Embedder } from "../ports";

/** Attempts for an embed that died in TRANSPORT — see isTransient. */
const TRANSPORT_ATTEMPTS = 3;

/**
 * True for a failure that says "the server never answered", not "the request
 * was wrong".
 *
 * This is the single biggest killer of newsroom runs: 197 of them died on
 * `ResponseError: Post "http://127.0.0.1:PORT/tokenize": EOF`. The shape is
 * confusing on purpose —
 *
 *   - the message is a GO error, because it is Ollama's own server reporting
 *     that ITS call to the model runner's /tokenize endpoint hit EOF, and
 *   - it arrives as HTTP **400**, so anything that retries only 5xx (as the
 *     sibling llm client does) sails straight past it.
 *
 * The runner dies mid-request because the box swaps models: with
 * OLLAMA_MAX_LOADED_MODELS=1 an embed request evicts the prose model's runner
 * and vice versa, and whichever call is in flight during the swap gets EOF.
 * Raising that limit is the real fix; this makes the desk survive the race
 * either way.
 */
export function isTransient(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\bEOF\b|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|terminated|timed? ?out|connection (closed|reset)/i.test(
    message,
  );
}

export function createOllamaEmbedder(cfg: {
  host: string;
  model: string;
  /** Where a retry announces itself; silent when absent. */
  log?: (line: string) => void;
}): Embedder {
  const client = new Ollama({ host: cfg.host });
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      let lastErr: unknown;
      for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt += 1) {
        try {
          const res = await client.embed({ model: cfg.model, input: texts });
          if (res.embeddings.length !== texts.length) {
            // A short vector list is a CONTENT failure — asking again verbatim
            // would return the same thing, so it is not retried.
            throw new Error(
              `ollama embed returned ${res.embeddings.length} vectors for ${texts.length} inputs (model=${cfg.model})`,
            );
          }
          return res.embeddings;
        } catch (err: unknown) {
          if (!isTransient(err) || attempt === TRANSPORT_ATTEMPTS) throw err;
          lastErr = err;
          // The runner needs a moment to come back up and reload the model.
          const backoffMs = 1500 * attempt;
          cfg.log?.(
            `ollama-embedder: transport failure on attempt ${attempt}/${TRANSPORT_ATTEMPTS} (model=${cfg.model}): ${String(lastErr)} — retrying in ${backoffMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
      // Unreachable: the loop returns or throws on the final attempt.
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}
