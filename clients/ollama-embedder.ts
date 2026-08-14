/**
 * `Embedder` port via the OFFICIAL `ollama` npm client (headline matching,
 * covered-story dedup). Model of record: `embeddinggemma` — pull it on the
 * serving box (`ollama pull embeddinggemma`, ~622 MB).
 * clients/** is the sanctioned SDK tree; the engine consumes only the port.
 */
import { Ollama } from "ollama";
import type { Embedder } from "../ports";

/** Attempts for an embed that died in TRANSPORT — see isTransient. */
const TRANSPORT_ATTEMPTS = 4;

/**
 * Backoff before each retry, in ms.
 *
 * Sized to outlast a RUNNER RESPAWN, not a blip: Ollama needs roughly ten
 * seconds to notice a dead runner, respawn it and reload the model, so a
 * faster schedule just burns attempts on a socket nobody is holding. The desk
 * runs every ~25 minutes; 23 seconds of patience is free.
 */
const BACKOFF_MS = [2_000, 6_000, 15_000];

/**
 * Texts per request — the thing that actually stops the failures.
 *
 * 197 newsroom runs died on `ResponseError: Post
 * "http://127.0.0.1:PORT/tokenize": EOF`. The shape is confusing on purpose:
 * the message is a GO error (Ollama's server reporting that ITS call to the
 * model runner hit EOF) and it arrives as HTTP **400**, so anything retrying
 * only 5xx sails straight past it.
 *
 * The cause is batch size. The desk embeds every probe against every headline
 * in the outlet index in ONE call, and that index doubled when ten
 * non-English papers joined the feed list — so a single request started
 * carrying a thousand-plus strings. That wedges the embedding runner, and
 * once wedged Ollama keeps routing to the dead port: observed 2026-08-13,
 * four retries across 23 seconds all reached the same corpse. No client-side
 * retry can rescue that, which is why chunking is the fix and the retry below
 * only covers the ordinary blip.
 *
 * Vectors are concatenated in order, and the model already serves one request
 * at a time under OLLAMA_NUM_PARALLEL=1, so nothing is lost by splitting.
 */
const BATCH = 128;

/** True for a failure that says "the server never answered", not "the request
 *  was wrong". Matched by MESSAGE, because these arrive as HTTP 400. */
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

  /** One request, with the transport retry wrapped around it. */
  async function embedChunk(texts: string[]): Promise<number[][]> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt += 1) {
      try {
        const res = await client.embed({ model: cfg.model, input: texts });
        if (res.embeddings.length !== texts.length) {
          // A short vector list is a CONTENT failure — asking again verbatim
          // returns the same thing, so it is raised on the first attempt.
          throw new Error(
            `ollama embed returned ${res.embeddings.length} vectors for ${texts.length} inputs (model=${cfg.model})`,
          );
        }
        return res.embeddings;
      } catch (err: unknown) {
        if (!isTransient(err) || attempt === TRANSPORT_ATTEMPTS) throw err;
        lastErr = err;
        const backoffMs = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        cfg.log?.(
          `ollama-embedder: transport failure on attempt ${attempt}/${TRANSPORT_ATTEMPTS} (model=${cfg.model}, ${texts.length} texts): ${String(lastErr)} — retrying in ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    // Unreachable: the loop returns or throws on the final attempt.
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      // Sequential on purpose: the point is to stop hammering one runner.
      for (let i = 0; i < texts.length; i += BATCH) {
        out.push(...(await embedChunk(texts.slice(i, i + BATCH))));
      }
      return out;
    },
  };
}
