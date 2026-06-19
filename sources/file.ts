/**
 * FileSource — a built-in `Source` that reads its signal (and optional facts)
 * from JSON files on disk. The simplest "plug data in" path: drop a
 * `DiscoverySignal` JSON next to the run and point at it (handy for fixtures,
 * golden-guard runs, and offline reproduction).
 *
 * The file contents are Zod-validated via `parseSignal`/`parseFacts`, so a
 * malformed file fails LOUD at the seam rather than corrupting the pipeline.
 *
 * `gatherFacts` is only exposed when `factsPath` is set, so a signal-only file
 * yields a signal-only Source.
 *
 * Imports only `./ports` + `./schemas` + the `node:fs/promises` built-in — no
 * `@/`, no `process.env`, no SDKs.
 */
import { readFile } from "node:fs/promises";
import type { DiscoverySignal, GroundingFacts, Source } from "../ports";
import { parseFacts, parseSignal } from "../schemas";

export interface FileSourceConfig {
  /** Path to a JSON file containing a `DiscoverySignal`. Required. */
  signalPath: string;
  /** Path to a JSON file containing `GroundingFacts`. Omit → no `gatherFacts`. */
  factsPath?: string;
}

/** Read + JSON-parse a file into an unknown value. */
async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

export function createFileSource(cfg: FileSourceConfig): Source {
  const source: Source = {
    async gatherSignal(): Promise<DiscoverySignal> {
      return parseSignal(await readJson(cfg.signalPath));
    },
  };

  if (cfg.factsPath) {
    const factsPath = cfg.factsPath;
    source.gatherFacts = async (): Promise<GroundingFacts> => {
      return parseFacts(await readJson(factsPath));
    };
  }

  return source;
}
