/**
 * `Embedder` port via mlx-embeddings on Apple Silicon. Same job as
 * `gemini-embedder.ts` / `ollama-embedder.ts`: headline matching for STEP 03.
 *
 * The runner is `mlx_embed.py` in this directory. It loads
 * `mlx-community/embeddinggemma-300m-4bit` through the library's `load` and
 * the model card's `model(input_ids, attention_mask)` forward, then returns
 * L2-normalised `text_embeds`. A missing interpreter, a missing package or
 * a non-zero exit is `EmbeddingUnavailable` — the match does not fall back
 * to trigrams.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EmbeddingUnavailable, type Embedder } from "../ports";

export const MLX_EMBED_MODEL = "mlx-community/embeddinggemma-300m-4bit";
export const MLX_EMBED_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "mlx_embed.py");

/** One Python process embeds this many texts. The model card's own example is
 *  a short list; a thousand index headlines in one `generate` would pad every
 *  row to the longest. */
const BATCH = 64;

export interface MlxEmbedRun {
  python: string;
  script: string;
  input: string;
  env: NodeJS.ProcessEnv;
}

export interface MlxEmbedResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface MlxEmbedderConfig {
  python?: string;
  script?: string;
  model?: string;
  log?: (line: string) => void;
  runImpl?: (req: MlxEmbedRun) => MlxEmbedResult;
}

function defaultRun(req: MlxEmbedRun): MlxEmbedResult {
  const spawned = spawnSync(req.python, ["-u", req.script], {
    input: req.input,
    encoding: "utf8",
    env: req.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60_000,
    killSignal: "SIGKILL",
  });
  return {
    status: spawned.status,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
    ...(spawned.error === undefined ? {} : { error: spawned.error }),
  };
}

function parseReply(stdout: string): number[][] {
  const blob = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (blob === undefined) {
    throw new Error("mlx-embedder: runner printed no JSON");
  }
  const parsed = JSON.parse(blob) as { embeddings?: unknown };
  if (!Array.isArray(parsed.embeddings)) {
    throw new Error("mlx-embedder: runner JSON had no embeddings array");
  }
  return parsed.embeddings as number[][];
}

export function createMlxEmbedder(cfg: MlxEmbedderConfig = {}): Embedder {
  const python = cfg.python ?? process.env.MLX_EMBED_PYTHON ?? "python3";
  const script = cfg.script ?? MLX_EMBED_SCRIPT;
  const model = cfg.model ?? process.env.MLX_EMBED_MODEL ?? MLX_EMBED_MODEL;
  const run = cfg.runImpl ?? defaultRun;

  async function embedChunk(texts: string[]): Promise<number[][]> {
    const req: MlxEmbedRun = {
      python,
      script,
      input: JSON.stringify({ texts }),
      env: { ...process.env, MLX_EMBED_MODEL: model, PYTHONUNBUFFERED: "1" },
    };
    const res = run(req);
    if (res.error !== undefined) {
      const err = new EmbeddingUnavailable(`mlx-embedder: ${res.error.message}`);
      cfg.log?.(`mlx-embedder: ${err.message}`);
      throw err;
    }
    if (res.status !== 0) {
      const detail = (res.stderr || res.stdout).trim() || `exit ${String(res.status)}`;
      const err = new EmbeddingUnavailable(`mlx-embedder: ${detail}`);
      cfg.log?.(`mlx-embedder: runner failed (status ${String(res.status)}): ${detail.split("\n").at(-1) ?? detail}`);
      throw err;
    }
    const vectors = parseReply(res.stdout);
    if (vectors.length !== texts.length) {
      throw new Error(
        `mlx embed returned ${vectors.length} vectors for ${texts.length} inputs (model=${model})`,
      );
    }
    return vectors;
  }

  return {
    get space(): string {
      return model;
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        out.push(...(await embedChunk(texts.slice(i, i + BATCH))));
      }
      return out;
    },
  };
}
