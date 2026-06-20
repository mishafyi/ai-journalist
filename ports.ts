/**
 * blog-engine — the entire customization contract (hexagonal ports).
 *
 * The engine is DOMAIN-AGNOSTIC: given a SIGNAL ("what's happening"), it
 * discovers a story, researches + writes it through the LLM/gate pipeline, and
 * emits a finished post. Everything proprietary is injected through the ports
 * below. Engine code imports NOTHING from a host app, ORM, or framework — an
 * AST purity guard (`__guard.checks.ts`) enforces it, so the private side can
 * never leak into the engine.
 *
 * ── "Plug any data in" — the primary requirement, three layers of effort ──
 *
 *   Layer 1 · Bring a CONFORMING API (zero engine code).
 *     Make your endpoint return `DiscoverySignal` / `GroundingFacts`; point
 *     `HttpSource({ signalUrl, factsUrl })` at it. A typical host feeds the
 *     engine from its own API endpoints — the data source is just an HTTP call
 *     against a published contract.
 *
 *   Layer 2 · Bring ANY API + a tiny map (a few lines).
 *     `HttpSource({ signalUrl, mapSignal: (raw) => DiscoverySignal })` bridges
 *     any response shape onto the contract. No engine changes.
 *
 *   Layer 3 · Bring a CUSTOM Source (full control).
 *     Implement `Source` directly — DB query, file, scrape, anything. A
 *     database-backed source is this (rich aggregations the wire contract can't
 *     express). The reference build ships `RssSource` + `FileSource`.
 *
 * The built-in sources (`HttpSource`/`RssSource`/`FileSource`/`composeSources`)
 * all implement `Source`, so "plug any data in" is CONFIG for the common cases
 * and CODE only when you need it.
 */
import type { ZodType } from "zod";

// ───────────────────────────────────────────────────────────────────────────
// The data contract — domain-agnostic shapes the engine consumes.
// An adopter's whole job is producing these (via a Source); the engine never
// knows where they came from.
// ───────────────────────────────────────────────────────────────────────────

/**
 * One unit of raw material for topic discovery — a headline, a funding round, a
 * release, a filing, a hiring company + its fresh roles — anything with a title +
 * entities the engine can cluster into a story.
 */
export interface SignalItem {
  /** Headline-ish label the discovery LLM reasons over. */
  title: string;
  /** The context the discovery LLM sees for this item. Fold domain specifics in
   *  here — e.g. pack `industry · sample roles · locations` into it. The
   *  engine never reads structured domain fields; the adapter formats them. */
  summary: string;
  /** Named entities (companies, people, products) — for clustering + linking.
   *  Untyped by design: the Linker re-extracts *typed* entities from the
   *  finished article, so the signal needn't classify them. */
  entities: string[];
  /** Recency (ISO 8601) — drives the "fresh story" bias. Omit if unknown. */
  date?: string;
  /** Canonical URL for the item, if any. */
  url?: string;
  /** Relative importance (e.g. count of fresh roles). Default 1. */
  weight?: number;
  /** Opaque passthrough the adapter round-trips (e.g. a slug/id it needs later). */
  meta?: Record<string, unknown>;
}

/**
 * The full discovery signal — the engine clusters items into candidate topics.
 * The Source owns the DATA (gathering the signal); the engine owns the LOGIC
 * (LLM query-generation → research → story-pick). So this carries the raw
 * material the engine's discovery pass reads, nothing pre-decided.
 */
export interface DiscoverySignal {
  items: SignalItem[];
  /** Optional human framing, e.g. "space/AI/robotics hiring, last 24h" — the
   *  adapter folds aggregate stats (totals, window) in here for the prompt. */
  framing?: string;
  /** Optional richer free-text corpus the query-generation pass reads beyond
   *  the per-item summaries (e.g. full source text the adapter gathers and folds
   *  into the signal). */
  corpus?: string;
}

/**
 * The chosen topic the engine hands back to the Source to fetch first-party
 * facts for, before writing. Deliberately leaner than the engine's internal
 * plan so adapters don't depend on engine internals.
 */
export interface TopicBrief {
  title: string;
  angle: string;
  entities: string[];
  /** The chosen topic's taxonomy key, when the engine derived one — lets the
   *  adapter fetch domain-correct facts + build the right on-site links. E.g. an
   *  internal category key (robotics|artificial-intelligence|…). */
  category?: string;
}

/** One citable first-party fact tied to the chosen topic. */
export interface Fact {
  /** The claim in words, e.g. "SpaceX has 1,768 open roles". */
  claim: string;
  /** Structured value when numeric — feeds the figure-grounding gate. */
  value?: string | number;
  /** Attribution label, e.g. "Example News data desk", "USAspending". */
  source: string;
  /** Link backing the fact. */
  url?: string;
  /** Entity the fact is about — for entity-linking. */
  entity?: string;
}

export interface GroundingFacts {
  facts: Fact[];
}

/** A previously-published topic, for anti-repetition. */
export interface CoveredTopic {
  title: string;
  slug?: string;
  entities?: string[];
  date?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// INPUT port — the primary seam ("what to write about" + "what to cite").
// ───────────────────────────────────────────────────────────────────────────

export interface Source {
  /** Raw material for topic discovery. The one required method. */
  gatherSignal(): Promise<DiscoverySignal>;
  /** First-party citable facts for the chosen topic. Optional → no grounding. */
  gatherFacts?(topic: TopicBrief): Promise<GroundingFacts>;
  /** Already-covered topics, for anti-repetition. Optional → none. */
  coveredTopics?(): Promise<CoveredTopic[]>;
}

// ───────────────────────────────────────────────────────────────────────────
// OUTPUT port — where the finished post goes.
// ───────────────────────────────────────────────────────────────────────────

export interface GeneratedPost {
  slug: string;
  title: string;
  markdown: string;
  description?: string;
  byline?: string;
  /** Gate results the pipeline recorded (publish-blockers, budgets, etc.). */
  telemetry?: Record<string, unknown>;
}

export interface PublishResult {
  url: string;
  status: "PUBLISHED" | "DRAFT";
}

export interface RunTelemetry {
  runId: string;
  slug?: string;
  stages?: { stage: string; input: string; output: string }[];
  llmRequests?: number;
  tokens?: number;
  error?: string;
}

export interface Sink {
  /** Persist the finished post. Reference default: write `out/<slug>.md`. */
  publish(post: GeneratedPost): Promise<PublishResult>;
  /** Optional run telemetry. Default → console. */
  recordRun?(run: RunTelemetry): Promise<void>;
}

// ───────────────────────────────────────────────────────────────────────────
// ENTITY-LINKING port — optional on-site links (e.g. links to your own pages).
// ───────────────────────────────────────────────────────────────────────────

export interface ResolvedLink {
  /** Anchor text found in the article. */
  anchor: string;
  /** On-site URL/path to link it to. */
  href: string;
}

export interface LinkPolicy {
  /** Valid href prefixes, for link-integrity enforcement. */
  allowedPrefixes: string[];
  /** True if a slug is real on the target site (optional stricter check). */
  validateSlug?: (slug: string) => boolean;
}

export interface Linker {
  /** Extract + resolve linkable entities → on-site links. */
  resolveLinks(article: string, facts: GroundingFacts): Promise<ResolvedLink[]>;
  policy?: LinkPolicy;
}

// ───────────────────────────────────────────────────────────────────────────
// CONFIG — runtime clients + brand voice + knobs. All have sensible defaults
// so the OSS build runs with just an LLM key.
// ───────────────────────────────────────────────────────────────────────────

export interface LlmClient {
  /** Single chat completion — the engine's free-text LLM dependency. */
  complete(args: {
    system?: string;
    prompt: string;
    model?: string;
    temperature?: number;
  }): Promise<string>;
  /**
   * Structured chat completion — constrains the model to the JSON Schema derived
   * from `schema` (provider-native `response_format: json_schema`), validates the
   * reply against that same Zod schema, and returns the typed object. Use where a
   * known shape is needed instead of free-text + regex/JSON-slice parsing: the
   * grammar-constrained reply can't wrap the data in prose, markdown fences, or
   * stray placeholder tokens. A malformed/schema-violating reply throws — wrap in
   * the caller's retry helper. The engine already depends on Zod, so the schema
   * is passed as a `ZodType`; the adapter maps it to the provider call.
   */
  completeStructured<T>(args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    schema: ZodType<T>;
    schemaName: string;
    model?: string;
    temperature?: number;
  }): Promise<T>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Full page text when scraped. */
  content?: string;
}

export interface SearchClient {
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
  scrape?(url: string): Promise<string>;
}

/** Optional — enables embedding-based dedup. Omit → trigram dedup only. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface BrandProfile {
  /** Short brand name woven into prompts, e.g. "Example News". */
  name: string;
  /** Publication identity, e.g. "Example News (example.com)". OSS default: generic. */
  publication: string;
  /** Domain framing — e.g. "space, AI, robotics". */
  beat: string;
  /** Anti-AI-writing banned-words list (ships with a sensible default). */
  bannedWords?: string[];
  /** Author pen names. */
  bylines: string[];
  /** Appended listing CTA. E.g. on-site route links. Optional → none. */
  ctaBuilder?: (post: GeneratedPost) => string;
}

export interface EngineConfig {
  llm: LlmClient;
  search: SearchClient;
  embedder?: Embedder;
  brand: BrandProfile;
  /** The ~70 BLOG_* tuning values; every one has a documented default. */
  knobs?: Record<string, string | number | boolean>;
}

// ───────────────────────────────────────────────────────────────────────────
// ADAPTER-INTERNAL deps the public ports cannot express (the adapter→engine seam).
//
// The four public ports above (Source / Sink / Linker / EngineConfig) are the
// MINIMAL contract — an adopter implements them and gets a running pipeline. But
// a full host's `runGeneration` orchestration can consume a much richer
// dependency set than those four can carry: several distinct first-party DATA
// gathers (the public `Source` collapses these into one `gatherFacts`), several
// CONTENT-REWRITING link functions interleaved at multiple pipeline points (which
// the single `Linker.resolveLinks(article,facts) → ResolvedLink[]` shape cannot
// express), many named numeric/regex knobs (the `EngineConfig.knobs` bag is
// untyped), the per-run `RunContext`/`withRetry`/telemetry writers, and pure text
// helpers the host still owns. Those have no clean home on the four ports.
//
// So a host adapter builds the typed deps bundles (`blogDeps` = DiscoveryDeps &
// SectionWriterDeps & AssemblyDeps, `gateDeps`, and the PipelineDeps tail) and
// hands them to the engine entry through this carrier on `RunInput.internals`. It
// stays ENGINE-PURE (every field is a function/value type from sibling engine
// modules — no host app, ORM, or framework imports), and it is OPTIONAL so the
// reference `sources/*` adopters (who supply only the four ports) are untouched.
// The entry (`index.ts` `runPipeline`) assembles the final `PipelineDeps` from
// the public ports it CAN map (config.llm → llm, source.gatherSignal/
// coveredTopics, sink.publish) plus this carrier.
//
// `import type` only — the resulting ports↔pipeline/discovery cycle is
// type-level (erased at runtime), so it introduces no runtime import cycle.
//
// `EngineInternals` is deliberately NON-generic: the engine's `runGeneration` is
// generic over the adapter's concrete board-company type (`TBoard`), so rather
// than thread that generic through the public `RunInput` (which would force a
// contravariant board cast at the boundary), the adapter pre-BINDS it into the
// `generate(plan)` closure. The board generic is resolved entirely adapter-side;
// nothing board-typed crosses the port boundary.
// ───────────────────────────────────────────────────────────────────────────
import type { GeneratedArticle } from "./pipeline";
import type { Plan } from "./planning";
import type { DiscoveryDeps } from "./discovery";
import type { SectionWriterDeps } from "./section-writer";
import type { AssemblyDeps } from "./assembly";

export interface EngineInternals {
  /** The discovery + section-writer + assembly deps (the adapter's `blogDeps`)
   *  — what the engine's Phase-1 discovery drives. */
  discoveryDeps: DiscoveryDeps & SectionWriterDeps & AssemblyDeps;
  /** Phase 2: the section-research → gate-chain orchestration, pre-bound to the
   *  adapter's full `PipelineDeps` (the proprietary DATA gathers + link tail +
   *  text helpers + named knobs + telemetry — the four public ports can't carry
   *  these). Board generic resolved adapter-side, so this stays non-generic. */
  generate: (plan: Plan) => Promise<GeneratedArticle>;
  /** Slugify the chosen story title → the stable publish slug (the adapter's
   *  `slugifyText`). Engine-pure: a pure `(s) => s` transform, no `@/`. */
  slugify: (title: string) => string;
  /** Wrap the finished GeneratedArticle → the engine's GeneratedPost envelope
   *  (byline + the run's gate telemetry). `topic` is the DISCOVERY story title
   *  (`plan.title`) — distinct from the article's final HEADLINE; the adapter
   *  needs it as the post's `targetKeyword` + the run's topic telemetry. The
   *  adapter owns the byline pick + the live telemetry snapshot; the dry-run
   *  preview reads the full Article it stashes here. */
  finalizePost: (
    article: GeneratedArticle,
    slug: string,
    topic: string,
  ) => GeneratedPost;
}

// ───────────────────────────────────────────────────────────────────────────
// The pure entrypoint — (source, sink, config) → post. Imports no `@/`, no
// prisma, no pathFor, no next. This signature is the engine's whole surface.
// ───────────────────────────────────────────────────────────────────────────

export interface RunInput {
  source: Source;
  sink: Sink;
  config: EngineConfig;
  /** Optional on-site entity linking. Omit → article ships with no internal links. */
  linker?: Linker;
  /** Fixed topic, or omit for autonomous discovery from the signal. */
  topic?: string;
  /** Don't publish — return the post for inspection (golden-guard / preview). */
  dryRun?: boolean;
  /**
   * The adapter-internal deps the four public ports can't express (see
   * `EngineInternals`). A full host adapter supplies it; a pure four-ports
   * adopter omits it (and gets only the minimal contract).
   */
  internals?: EngineInternals;
}

export type RunPipeline = (input: RunInput) => Promise<GeneratedPost>;
