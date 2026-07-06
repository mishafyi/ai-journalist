/**
 * ai-journalist — per-run telemetry / artifact state, held in a passed object
 * instead of module globals.
 *
 * Every full blog run accumulates three things: a stable run id (groups the
 * run's log rows in the host's logging UI), a `RunTelemetry` record
 * (discovery decisions, per-call LLM usage, retries, final article metrics),
 * and a list of per-stage `RunArtifact`s (provenance, flushed to the host's
 * artifact store at run end). Previously these lived as module-level globals in
 * the host adapter; threading them through a `RunContext` is the prerequisite for
 * moving the gate passes into the engine (they write to this state).
 *
 * Engine-pure: imports nothing from a host app, ORM, or framework. The run id is
 * SEEDED by the caller (a host supplies its own id generator), so the type stays
 * domain-agnostic. The writes are plain accumulators — no I/O.
 */

/** Per-label LLM usage, diffed from the process-wide OpenRouter usage meter. */
export interface LlmCallStat {
  label: string;
  attempts: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  /** The model id that served the successful call (as reported by the provider response). */
  model?: string;
  /**
   * The provider's generation id (OpenRouter `response.id`), joinable to
   * GET /api/v1/generation for per-call provider-side metadata.
   */
  generationId?: string;
}

/**
 * The run's telemetry record. One log row per run carries this verbatim
 * (runId-grouped) — discovery decisions, per-call LLM usage (the SDK's usage
 * field — never discarded), every retry, and final article metrics.
 */
export interface RunTelemetry {
  mode: string;
  topic?: string;
  slug?: string;
  discovery?: Record<string, unknown>;
  llmCalls: LlmCallStat[];
  retries: { label: string; attempt: number; error: string; body?: string }[];
  article?: Record<string, unknown>;
  datagodBlock?: string;
}

/**
 * One per-stage artifact (provenance). Accumulated like `telemetry.llmCalls`
 * and flushed to the host's artifact store at run end. runId + slug are stamped
 * at write time (persist step), so capture sites stay decoupled from run identity.
 */
export interface RunArtifact {
  stage: string;
  seq: number;
  input: string | null;
  output: string;
  promptTokens: number | null;
  completionTokens: number | null;
  ms: number | null;
}

/**
 * The per-run state, held in one passed object. Replaces the old module globals
 * (`RUN_ID` / `telemetry` / `runArtifacts`). Carries the accumulators plus the
 * write closures every site uses; the same data is produced, just stored here.
 */
export interface RunContext {
  /** Current run id — for phase modules that share this run's log rows. */
  readonly runId: string;
  /** The mutable telemetry record (read + field writes both go through this). */
  readonly telemetry: RunTelemetry;
  /** The accumulated per-stage artifacts (flushed by the persist step). */
  readonly runArtifacts: RunArtifact[];
  /** Record a per-stage artifact (provenance). Mirrors the old `recordArtifact`. */
  recordArtifact(
    stage: string,
    input: string | null,
    output: string,
    stat?: { promptTokens?: number; completionTokens?: number; ms?: number },
  ): void;
  /** Record a per-label LLM usage stat. */
  recordLlmCall(stat: LlmCallStat): void;
  /** Record a retry (label/attempt/error, optional response body slice). */
  recordRetry(retry: {
    label: string;
    attempt: number;
    error: string;
    body?: string;
  }): void;
}

/**
 * Build a fresh per-run context. The CLI never needs more than one (one run per
 * process), but the ingest-tier scheduler reuses a long-lived process across
 * cron runs — each run gets its own context so runId/telemetry/artifacts never
 * bleed between runs.
 *
 * @param seedRunId the run id (a host seeds it from its own id generator).
 *   Injected so this module stays engine-pure (no host import for id generation).
 */
export function createRunContext(seedRunId: string): RunContext {
  const telemetry: RunTelemetry = { mode: "topic", llmCalls: [], retries: [] };
  const runArtifacts: RunArtifact[] = [];
  let artifactSeq = 0;
  return {
    runId: seedRunId,
    telemetry,
    runArtifacts,
    recordArtifact(stage, input, output, stat) {
      runArtifacts.push({
        stage,
        seq: artifactSeq++,
        input,
        output,
        promptTokens: stat?.promptTokens ?? null,
        completionTokens: stat?.completionTokens ?? null,
        ms: stat?.ms ?? null,
      });
    },
    recordLlmCall(stat) {
      telemetry.llmCalls.push(stat);
    },
    recordRetry(retry) {
      telemetry.retries.push(retry);
    },
  };
}
