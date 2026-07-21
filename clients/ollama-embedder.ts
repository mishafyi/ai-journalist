/**
 * `Embedder` port via the OFFICIAL `ollama` npm client (headline matching,
 * covered-story dedup). Model of record: `embeddinggemma` — pull it on the
 * serving box (`ollama pull embeddinggemma`, ~622 MB).
 * clients/** is the sanctioned SDK tree; the engine consumes only the port.
 */
import { Ollama } from "ollama";
import type { Embedder } from "../ports";

export function createOllamaEmbedder(cfg: { host: string; model: string }): Embedder {
  const client = new Ollama({ host: cfg.host });
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await client.embed({ model: cfg.model, input: texts });
      if (res.embeddings.length !== texts.length) {
        throw new Error(
          `ollama embed returned ${res.embeddings.length} vectors for ${texts.length} inputs (model=${cfg.model})`,
        );
      }
      return res.embeddings;
    },
  };
}
