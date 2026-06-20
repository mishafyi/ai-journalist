/**
 * Record/replay harness for the `LlmClient` / `SearchClient` / `Embedder`
 * ports — the injectable seam the golden guard (Task 5) depends on.
 *
 * No record/replay library exists in the repo, so this is a thin port-level
 * wrapper over `node:crypto` (the standard `createHash("sha256")`
 * primitive). The engine is deterministic given fixed LLM +
 * search outputs, so a recorded fixture lets the golden test run the WHOLE
 * pipeline with zero network and assert byte-stable output.
 *
 *   record* wraps a live client, captures every call keyed by a sha256 of its
 *          args, and exposes the captured map via `fixture()`.
 *   replay* serves from a fixture and THROWS on an unknown key — so any drift
 *          (a new prompt, a changed query) surfaces loudly instead of silently
 *          hitting the network or returning stale data.
 *
 * `testing/**` shares `clients/**`'s SDK/env exemption — but this
 * file touches neither; it only wraps the ports.
 */
import { createHash } from "node:crypto";
import type { Embedder, LlmClient, SearchClient, SearchResult } from "../ports";

/** A captured set of port calls, keyed by the sha256 of each call's args. */
export type Fixture<T> = Record<string, T>;

/** sha256 of a stable JSON encoding of the call args — the fixture key.
 *  Mirrors `contentHash.ts`: `createHash("sha256").update(...).digest("hex")`. */
function keyOf(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args)).digest("hex");
}

// ── LlmClient ────────────────────────────────────────────────────────────────

/** A recording `LlmClient` exposes the captured completions for persistence. */
export interface RecordingLlm extends LlmClient {
  fixture(): Fixture<string>;
}

/** Wrap a live `LlmClient`; memoize every completion keyed by its args. Both
 *  free-text (`complete`) and structured (`completeStructured`) calls land in the
 *  SAME string-keyed map: a structured result is stored JSON-serialized (the
 *  schema is excluded from the key — it isn't JSON-stable — but the schemaName +
 *  messages identify the call), mirroring how the golden transcript records
 *  structured stages as JSON strings. */
export function recordingLlm(inner: LlmClient): RecordingLlm {
  const captured: Fixture<string> = {};
  return {
    async complete(args) {
      const key = keyOf({
        system: args.system,
        prompt: args.prompt,
        model: args.model,
        temperature: args.temperature,
      });
      const text = await inner.complete(args);
      captured[key] = text;
      return text;
    },
    async completeStructured(args) {
      const key = keyOf({
        messages: args.messages,
        schemaName: args.schemaName,
        model: args.model,
        temperature: args.temperature,
      });
      const result = await inner.completeStructured(args);
      captured[key] = JSON.stringify(result);
      return result;
    },
    fixture() {
      return { ...captured };
    },
  };
}

/** Serve completions from a fixture; throw on an unknown key (drift surfaces).
 *  A structured replay parses the recorded JSON string and re-validates it
 *  through the caller's schema, so a fixture that drifts from the schema fails
 *  loudly (same contract the live `completeStructured` enforces). */
export function replayLlm(fixture: Fixture<string>): LlmClient {
  return {
    async complete(args) {
      const key = keyOf({
        system: args.system,
        prompt: args.prompt,
        model: args.model,
        temperature: args.temperature,
      });
      const text = fixture[key];
      if (text === undefined) {
        throw new Error(`replayLlm: no recorded completion for key ${key}`);
      }
      return text;
    },
    async completeStructured(args) {
      const key = keyOf({
        messages: args.messages,
        schemaName: args.schemaName,
        model: args.model,
        temperature: args.temperature,
      });
      const text = fixture[key];
      if (text === undefined) {
        throw new Error(
          `replayLlm: no recorded structured completion for key ${key}`,
        );
      }
      return args.schema.parse(JSON.parse(text));
    },
  };
}

// ── SearchClient ─────────────────────────────────────────────────────────────

/** A recording `SearchClient` exposes captured searches + scrapes. */
export interface RecordingSearch extends SearchClient {
  searchFixture(): Fixture<SearchResult[]>;
  scrapeFixture(): Fixture<string>;
}

/** Wrap a live `SearchClient`; memoize searches (keyed by `{query, limit}`) and
 *  scrapes (keyed by `{url}`). */
export function recordingSearch(inner: SearchClient): RecordingSearch {
  const searches: Fixture<SearchResult[]> = {};
  const scrapes: Fixture<string> = {};
  return {
    async search(query, opts) {
      const key = keyOf({ query, limit: opts?.limit });
      const results = await inner.search(query, opts);
      searches[key] = results;
      return results;
    },
    async scrape(url) {
      if (!inner.scrape) {
        throw new Error("recordingSearch: inner client has no scrape()");
      }
      const key = keyOf({ url });
      const content = await inner.scrape(url);
      scrapes[key] = content;
      return content;
    },
    searchFixture() {
      return { ...searches };
    },
    scrapeFixture() {
      return { ...scrapes };
    },
  };
}

/** Serve searches + scrapes from fixtures; throw on an unknown key. */
export function replaySearch(
  searchFixture: Fixture<SearchResult[]>,
  scrapeFixture: Fixture<string>,
): SearchClient {
  return {
    async search(query, opts) {
      const key = keyOf({ query, limit: opts?.limit });
      const results = searchFixture[key];
      if (results === undefined) {
        throw new Error(`replaySearch: no recorded search for key ${key}`);
      }
      return results;
    },
    async scrape(url) {
      const key = keyOf({ url });
      const content = scrapeFixture[key];
      if (content === undefined) {
        throw new Error(`replaySearch: no recorded scrape for key ${key}`);
      }
      return content;
    },
  };
}

// ── Embedder ─────────────────────────────────────────────────────────────────

/** A recording `Embedder` exposes captured embeddings for persistence. */
export interface RecordingEmbedder extends Embedder {
  fixture(): Fixture<number[][]>;
}

/** Wrap a live `Embedder`; memoize every embed call keyed by its texts. */
export function recordingEmbedder(inner: Embedder): RecordingEmbedder {
  const captured: Fixture<number[][]> = {};
  return {
    async embed(texts) {
      const key = keyOf({ texts });
      const vectors = await inner.embed(texts);
      captured[key] = vectors;
      return vectors;
    },
    fixture() {
      return { ...captured };
    },
  };
}

/** Serve embeddings from a fixture; throw on an unknown key. */
export function replayEmbedder(fixture: Fixture<number[][]>): Embedder {
  return {
    async embed(texts) {
      const key = keyOf({ texts });
      const vectors = fixture[key];
      if (vectors === undefined) {
        throw new Error(`replayEmbedder: no recorded embedding for key ${key}`);
      }
      return vectors;
    },
  };
}
