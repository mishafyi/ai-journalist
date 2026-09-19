/**
 * Run tracer — the article's creation map.
 *
 * ONE JSON file per pipeline STEP, holding every call that step made: the
 * complete request and the complete response of each, in order. A step that
 * calls the model six times (evidence extraction over six chunks) or retries
 * under contract (the column) keeps all of it in its own single file.
 *
 * Steps are identified from the call itself — a structured call's schema
 * name, a free-text call's opening instruction, a search's query shape — so
 * the clients stay unaware of the pipeline they serve. An unrecognised call
 * lands in `99-unclassified.json` rather than being dropped: a trace that
 * silently loses calls is worse than no trace.
 *
 * Writes are whole-file per record, so a run that dies mid-step keeps
 * everything recorded up to the moment it died. Tracing observes; a failed
 * write never fails the call it was watching.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

/**
 * An error rendered with its CAUSE CHAIN, for a trace or a log.
 *
 * Node wraps every transport failure as a bare `TypeError: fetch failed` and
 * puts the reason — connect timeout, reset, DNS, a server that hung up on a
 * pooled socket — on `err.cause`. `String(err)` drops it, which is how 35
 * recorded failures on 2026-09-03 all read as the same useless line with
 * nothing to diagnose; the distinction matters, because a connect timeout
 * points at the uplink, a reset at the far end and ENOTFOUND at DNS here.
 *
 * `util.inspect` already does this properly: it renders `[cause]` recursively
 * with each cause's `code`, handles circular chains, and needs no dependency.
 * Depth 4 is enough for wrapper → cause → cause and stops short of dumping a
 * whole request object.
 */
export function describeError(err: unknown): string {
  return inspect(err, { depth: 4, breakLength: Infinity });
}

export interface TraceMessage {
  role: string;
  content: string;
}

export interface LlmTrace {
  model: string;
  temperature?: number;
  /** Set for grammar-constrained calls; identifies the step outright. */
  schemaName?: string;
  system?: string;
  prompt?: string;
  messages?: TraceMessage[];
  response?: string;
  error?: string;
}

export interface SearchTrace {
  query: string;
  op: "search" | "scrape";
  /** Forces the step file. For raw HTTP a host traces itself (encyclopedia
   *  verification, the lead-image hunt), where the query shape says nothing. */
  step?: string;
  options?: Record<string, unknown>;
  results?: { title: string; url: string; snippet: string; contentChars?: number }[];
  /** Full page text for a scrape — the evidence every later step rests on. */
  content?: string;
  error?: string;
}

export interface Tracer {
  llm(entry: LlmTrace): void;
  search(entry: SearchTrace): void;
}

/** Which step a model call belongs to. Schema names are exact; the free-text
 *  calls are identified by the opening words of their standing instructions,
 *  which are fixed strings in the preset and the gates. */
function stepForLlm(entry: LlmTrace): string {
  const system = entry.system ?? entry.messages?.find((m) => m.role === "system")?.content ?? "";
  const user = entry.prompt ?? entry.messages?.find((m) => m.role === "user")?.content ?? "";
  switch (entry.schemaName) {
    case "parallel_candidates":
      return "07-parallel-propose";
    case "echo_candidates":
      return "10-echoes-propose";
    case "parallel_judge":
      return "09-parallel-judge";
    case "story_tags":
      return "06-story-tags";
    case "column_headline":
      return "16-headline";
    case "wire_headline_translation":
      return "17-headline-translation";
    case "voice_pick":
      return "04b-voice-pick";
    case "data_play_pick":
      return "05b-data-plays";
    case "story_principals":
      return "05c-principals";
    case "dossier_rate_sources":
      return "05c1-dossier-rate-sources";
    case "dossier_plan_searches":
      return "05c2-dossier-plan-searches";
    case "dossier_pick_documents":
      return "05c3-dossier-pick-documents";
    case "dossier_notes":
      return "05c4-dossier-notes";
    case "story_connections":
      return "05d-connections";
    case "story_hypotheses":
      return "05e-hypotheses";
    default:
      break;
  }
  if (system.startsWith("You extract evidence for a news article")) return "05-evidence-extraction";
  if (system.includes("an opinion columnist writing your complete column")) return "12-column";
  if (user.startsWith("Audit this column for publication")) return "13-audit";
  if (user.startsWith("You are a fact-checker reviewing a PUBLISHED article")) return "19-fact-check-audit";
  return "99-unclassified";
}

/** Which step a search belongs to: the hunt is site-restricted, the parallel
 *  research carries its fixed suffix, and a scrape is a scrape. */
function stepForSearch(entry: SearchTrace): string {
  if (entry.step !== undefined && entry.step !== "") return entry.step;
  if (entry.op === "scrape") return "04-scrape";
  if (/^site:/i.test(entry.query)) return "03-resolution-hunt";
  if (/history mechanism significance$/.test(entry.query)) return "08-parallel-research";
  return "99-unclassified";
}

export function createTracer(cfg: { dir: string }): Tracer {
  const steps = new Map<string, unknown[]>();
  let seq = 0;

  function record(step: string, call: Record<string, unknown>): void {
    try {
      mkdirSync(cfg.dir, { recursive: true });
      seq += 1;
      const calls = steps.get(step) ?? [];
      calls.push({ seq, ts: new Date().toISOString(), ...call });
      steps.set(step, calls);
      writeFileSync(join(cfg.dir, `${step}.json`), JSON.stringify({ step, calls }, null, 1));
    } catch {
      // tracing observes; it never fails the call it was watching
    }
  }

  return {
    llm(entry) {
      record(stepForLlm(entry), { kind: "llm", ...entry });
    },
    search(entry) {
      record(stepForSearch(entry), { kind: entry.op, ...entry });
    },
  };
}
