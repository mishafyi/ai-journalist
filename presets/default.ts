/**
 * `createDefaultInternals` — the single factory that assembles a complete,
 * working `EngineInternals` from ~4 inputs (an `LlmClient`, a `SearchClient`, a
 * `BrandProfile`, and a `Source`). It is the batteries-included path: an adopter
 * who has those four ports gets the REAL Phase-2 pipeline (section research →
 * draft → the real editor + gate chain → SEO) with no gate-chain wiring of their
 * own, versus `examples/basic.ts`'s pass-through stubs.
 *
 * This is the difference vs the example: here `runEdit`/`runFinalEdit`/`runTitle`/
 * `runSeo` are the ENGINE's real gate passes, bound to a shared `RunContext`, and
 * `generate` is the real `runGeneration`. The example stubs them so it stays a
 * pure wiring demo; this preset stubs NOTHING on the generation path.
 *
 * CORE module (subject to the AST purity guard): no `process.env`, no brand
 * literals, no host/model ids. Every knob comes from `DefaultInternalsOptions`;
 * every default is a plain numeric constant documented against the engine
 * docstrings + `examples/basic.ts`. An omitted `model` becomes `""`, which the
 * bundled OpenRouter client treats as unpinned → dynamic top-weekly-free
 * selection (see `clients/openrouter-llm.ts`).
 *
 * The generation pipeline is generic over the adapter's board-company type; a
 * four-ports adopter has none, so the preset binds the base `PipelineBoardCompany`
 * and omits `enrichment` (→ `neutralEnrichment()`): the core writer runs without
 * any first-party data / link tail.
 */
import { runGeneration } from "../pipeline";
import type {
  GeneratedArticle,
  PipelineBoardCompany,
  PipelineDeps,
  PipelineEnrichment,
} from "../pipeline";
import { runEdit, runFinalEdit } from "../gates";
import type { GateDeps } from "../gates";
import { createRunContext } from "../run-context";
import type { DiscoveryDeps } from "../discovery";
import type { SectionWriterDeps } from "../section-writer";
import type { AssemblyDeps } from "../assembly";
import type { Plan, PlanSection } from "../planning";
import type { ResearchStack } from "../research";
import type {
  BrandProfile,
  Embedder,
  EngineInternals,
  GeneratedPost,
  LlmClient,
  SearchClient,
  Source,
} from "../ports";
import { cosineSimilarity } from "../text";
import {
  stripPreambleAndFence,
  isArticleShaped,
  lengthSafe,
  countVagueBanding,
  dropDuplicateSentences,
  findRepeatedShingles,
  shingleOccurrences,
  emdashClusteredLines,
  META_PROSE_RE,
  COT_PREFIX_RE,
  PREAMBLE_LINE_RE,
} from "./text-defaults";
import headlines from "../headlines.json";

/**
 * The tunable numeric knobs the pipeline reads, with the engine's documented
 * defaults. Discovery values mirror `examples/basic.ts`; pipeline/gate values
 * mirror the engine docstrings' documented defaults. Override any via
 * `DefaultInternalsOptions.knobs`.
 */
export interface DefaultKnobs {
  // ── discovery (mirror examples/basic.ts) ──
  dedupThreshold: number;
  embedDedupSim: number;
  discoveryQueries: number;
  newsCompanies: number;
  maxSections: number;
  sectionQueries: number;
  researchConcurrency: number;
  snippetsPerQuery: number;
  rssPerCompany: number;
  // ── section writer ──
  sectionSnippets: number;
  sectionConcurrency: number;
  // ── pipeline surgical passes ──
  researchPersistChars: number;
  repeatShingleWords: number;
  repeatTrigger: number;
  sentenceDedupMinChars: number;
  clauseDedupMinChars: number;
  /** null → the pipeline's per-length em-dash default. */
  emdashMaxEnv: number | null;
  tableMinFigures: number;
  attribTagMax: number;
  draftWordWarnFloor: number;
  // ── title gate ──
  titleExemplarCount: number;
  titleCollisionSim: number;
  titleEmbedSim: number;
  searchTermsCount: number;
  // ── gate input caps (gates.ts internal defaults, passed through verbatim) ──
  /** Chars of pooled ground truth the fact-check audit sees (120000). Lower to
   *  fit small-context local models — a 120K-char audit prompt is unusable
   *  there. */
  auditInputChars: number;
  /** Chars of finished article runSeo feeds the metadata prompt (24000). */
  seoInputChars: number;
  /** Word floor injected into the runEdit/runFinalEdit prompts (1200). */
  editWordFloor: number;
}

/** The engine's documented defaults for every knob. */
const DEFAULT_KNOBS: DefaultKnobs = {
  dedupThreshold: 0.37,
  embedDedupSim: 0.86,
  discoveryQueries: 15,
  newsCompanies: 12,
  maxSections: 7,
  sectionQueries: 3,
  researchConcurrency: 4,
  snippetsPerQuery: 5,
  rssPerCompany: 5,
  sectionSnippets: 4,
  sectionConcurrency: 3,
  researchPersistChars: 2_000_000,
  repeatShingleWords: 6,
  repeatTrigger: 3,
  sentenceDedupMinChars: 60,
  clauseDedupMinChars: 40,
  emdashMaxEnv: null,
  tableMinFigures: 4,
  attribTagMax: 4,
  draftWordWarnFloor: 1500,
  titleExemplarCount: 24,
  titleCollisionSim: 0.45,
  titleEmbedSim: 0.9,
  searchTermsCount: 12,
  // MUST equal the gates' internal `??` defaults (gates.ts) so non-opting
  // adopters see byte-identical prompts — passing the same value through is a
  // no-op.
  auditInputChars: 120_000,
  seoInputChars: 24_000,
  editWordFloor: 1_200,
};

/** One headline-corpus entry — `headlines.json` is an array of these. */
interface HeadlineEntry {
  title: string;
  source: string;
  domain: string;
}

/** The options `createDefaultInternals` accepts — four essentials + overrides. */
export interface DefaultInternalsOptions {
  llm: LlmClient;
  search: SearchClient;
  brand: BrandProfile;
  source: Source;
  /** Pinned model id; omit → "" (falsy), which the bundled OpenRouter client
   *  treats as unpinned → dynamic top-weekly-free selection. */
  model?: string;
  /** Run id for telemetry; omit → "run_" + counter (per-factory). */
  runId?: string;
  /** Domain enrichment (Task 1); omit → neutralEnrichment(). */
  enrichment?: PipelineEnrichment<PipelineBoardCompany>;
  /** Optional embedding backend. Supplied → embedding-based near-paraphrase
   *  dedup for topics + title candidates (the engine's embedDedupSurvivors);
   *  omitted → null, i.e. trigram-only dedup (the documented degradation). */
  embedder?: Embedder;
  /** Override any numeric knob; unspecified ones use the documented defaults. */
  knobs?: Partial<DefaultKnobs>;
  /** withRetry attempt budget; omit → 3. */
  maxAttempts?: number;
  /** Observability hooks; omit → silent no-ops. */
  onEvent?: DiscoveryDeps["onEvent"];
  onError?: (
    phase: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => void;
  /** Prior published titles for the title gate; omit → derived from
   *  source.coveredTopics() (or [] if the source has none). */
  fetchPriorTitles?: () => Promise<string[]>;
  /** System prompt; omit → a generic-journalist prompt built from brand. */
  systemPrompt?: () => string;
  /** Deep per-section researcher; omit → a snippet block from `search()` (or
   *  `research.gatherResearch` when a stack is supplied — an explicit value
   *  here still wins). Supply to ground sections in scraped full pages instead
   *  of snippets. */
  gatherResearch?: (topic: string) => Promise<{ block: string }>;
  /** Pre-built research stack (`createResearchStack`). Present → the factory
   *  late-binds its OWN `withRetry` + `recordArtifact` into it via
   *  `research.bind(...)` — both are constructed inside this factory, so a
   *  pre-built stack cannot receive them any earlier; the bind is what routes
   *  the stack's transport retries + artifacts into the run's telemetry.
   *  Also defaults `gatherResearch` to the stack's (see above) and wires the
   *  section-writer's thin-section backfill
   *  `retryThin: (s) => research.retryThin(s.heading)`. Absent → nothing
   *  changes. */
  research?: ResearchStack;
}

/** Per-factory monotonic counter for the default run id. */
let runCounter = 0;

/** Fisher–Yates shuffle over a copy — pure, no input mutation. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Assemble a complete, working `EngineInternals` from the four essential ports
 * plus optional overrides. The returned carrier drives `runPipeline`'s Phase-2
 * generation with the REAL editor + gate chain.
 */
export function createDefaultInternals(
  opts: DefaultInternalsOptions,
): EngineInternals {
  const { llm, search, brand, source } = opts;
  const model = opts.model ?? "";
  const knobs: DefaultKnobs = { ...DEFAULT_KNOBS, ...opts.knobs };
  const runId = opts.runId ?? `run_${(runCounter += 1)}`;
  const onEvent = opts.onEvent;
  const onError =
    opts.onError ??
    ((): void => {
      /* silent no-op */
    });

  // ── 2. per-run context + bound artifact writer (declared before withRetry,
  //      which records retries onto it).
  const ctx = createRunContext(runId);
  const recordArtifact = ctx.recordArtifact.bind(ctx);

  // ── 1. withRetry — generic 3-attempt exponential backoff (250ms base) that
  //      records each failure to ctx before retrying; rethrows the last error.
  //      Honors opts.maxAttempts (or the per-call opts.maxAttempts override).
  const defaultAttempts = opts.maxAttempts ?? 3;
  const withRetry = async <T>(
    label: string,
    fn: () => Promise<T>,
    callOpts?: { input?: string; maxAttempts?: number },
  ): Promise<T> => {
    const attempts = callOpts?.maxAttempts ?? defaultAttempts;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        ctx.recordRetry({
          label,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < attempts) {
          const delayMs = 250 * 2 ** (attempt - 1);
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError;
  };

  // ── 2.5. research-stack late-bind — a pre-built stack can only receive the
  //      factory's withRetry/recordArtifact NOW (both are constructed above);
  //      bind() routes its transport retries + artifacts into THIS run's
  //      telemetry. Absent → no-op.
  const research = opts.research;
  research?.bind({ withRetry, recordArtifact });

  // ── 3. system prompt — generic staff-journalist prompt built from the brand
  //      (no literals; guard-safe).
  const systemPrompt =
    opts.systemPrompt ??
    ((): string =>
      `You are a rigorous staff journalist writing for ${brand.publication}. Ground every claim in the provided research; never invent figures, names, or quotes.`);

  // ── 4. search snippets — "<title> — <snippet>" per result.
  const searchSnippets = async (q: string, limit: number): Promise<string[]> =>
    (await search.search(q, { limit })).map((r) => `${r.title} — ${r.snippet}`);

  // ── 5. deep research block — one gatherResearch per section primary query.
  //      Overridable (opts.gatherResearch) so hosts can ground sections in
  //      scraped full pages; with a research stack the default is the stack's
  //      tier-ranked scraping gather; otherwise the cheap snippet block.
  const gatherResearch =
    opts.gatherResearch ??
    (research
      ? (topic: string): Promise<{ block: string }> =>
          research.gatherResearch(topic)
      : async (topic: string): Promise<{ block: string }> => ({
          block: (await search.search(topic, { limit: knobs.snippetsPerQuery }))
            .map((r) => `- ${r.title}: ${r.snippet}`)
            .join("\n"),
        }));

  // ── 6. covered topics + prior titles — both derive from source.coveredTopics.
  const gatherCoveredTopics = async (): Promise<string[]> =>
    (await source.coveredTopics?.())?.map((t) => t.title) ?? [];
  const fetchPriorTitles = opts.fetchPriorTitles ?? gatherCoveredTopics;

  // ── 7. embedder → embedding-grade near-paraphrase dedup; omitted → null
  //      (trigram dedup only, the documented degradation). Bound into BOTH
  //      gateDeps (title candidates) and discoveryDeps (topics) below.
  //      Per-factory embedding cache — the same covered-topic strings are
  //      re-embedded on every discovery round otherwise (mirrors the host
  //      adapter's cache).
  const embedCache = new Map<string, number[]>();
  const embedDedupSurvivors = opts.embedder
    ? async (
        candidates: string[],
        covered: string[],
        simThreshold: number,
      ): Promise<{
        survivors: string[];
        dropped: { cand: string; closest: string; sim: number }[];
      } | null> => {
        const embedder = opts.embedder;
        if (!embedder) return null;
        const misses = [...new Set([...covered, ...candidates])].filter(
          (t) => t.length > 0 && !embedCache.has(t),
        );
        if (misses.length > 0) {
          const vectors = await embedder.embed(misses);
          misses.forEach((t, i) => embedCache.set(t, vectors[i]));
        }
        const vecOf = (t: string): number[] | undefined => embedCache.get(t);
        const survivors: string[] = [];
        const dropped: { cand: string; closest: string; sim: number }[] = [];
        for (const cand of candidates) {
          const cv = vecOf(cand);
          if (!cv) {
            survivors.push(cand);
            continue;
          }
          let closest = "";
          let best = -Infinity;
          for (const cov of covered) {
            const covVec = vecOf(cov);
            if (!covVec) continue;
            const sim = cosineSimilarity(cv, covVec);
            if (sim > best) {
              best = sim;
              closest = cov;
            }
          }
          if (covered.length > 0 && best >= simThreshold) {
            dropped.push({ cand, closest, sim: best });
          } else {
            survivors.push(cand);
          }
        }
        return { survivors, dropped };
      }
    : async (): Promise<null> => null;

  // ── 8. headline-corpus exemplar sampler — mirror of the host's:
  //      70% from entries whose domain === category (fall back to "general",
  //      then any), shuffled, sliced, returning the title strings.
  const corpus = headlines as HeadlineEntry[];
  const gatherExemplars = (category: string, count: number): string[] => {
    const inDomain = (domain: string): HeadlineEntry[] =>
      corpus.filter((h) => h.domain === domain);
    let matched = inDomain(category);
    if (matched.length === 0) matched = inDomain("general");
    if (matched.length === 0) matched = corpus;
    const primaryCount = Math.round(count * 0.7);
    const primary = shuffled(matched).slice(0, primaryCount);
    const rest = shuffled(corpus).slice(0, count - primary.length);
    return [...primary, ...rest].slice(0, count).map((h) => h.title);
  };

  // ── the real gate-pass couplings (./gates). runEdit/runFinalEdit/runTitle/
  //    runSeo/fact-guard/fact-check all read this.
  const gateDeps: GateDeps = {
    llm,
    model,
    withRetry,
    ctx,
    gatherExemplars,
    fetchPriorTitles,
    embedDedupSurvivors,
    titleExemplarCount: knobs.titleExemplarCount,
    titleCollisionSim: knobs.titleCollisionSim,
    titleEmbedSim: knobs.titleEmbedSim,
    searchTermsCount: knobs.searchTermsCount,
    auditInputChars: knobs.auditInputChars,
    seoInputChars: knobs.seoInputChars,
    editWordFloor: knobs.editWordFloor,
  };

  // ── 9. section-writer + assembly deps. The REAL editor passes bound to
  //      gateDeps (the core difference vs examples/basic.ts's pass-through stubs).
  const blogDeps: SectionWriterDeps &
    AssemblyDeps & {
      onError: (
        phase: string,
        error: unknown,
        context?: Record<string, unknown>,
      ) => void;
    } = {
    llm,
    gatherResearch,
    // Thin-section backfill — the stack's dropped-URL retry adapted to the
    // section-writer seam. Wired HERE, on the shared deps object BEFORE the
    // `discoveryDeps = { ...blogDeps }` spread-copy below, so BOTH consumers
    // (pipelineDeps.blogDeps AND discoveryDeps) see it.
    retryThin: research
      ? (s: PlanSection): Promise<string> => research.retryThin(s.heading)
      : undefined,
    searchSnippets,
    systemPrompt,
    withRetry,
    onError,
    model,
    sectionSnippets: knobs.sectionSnippets,
    sectionConcurrency: knobs.sectionConcurrency,
    brandName: brand.name,
    runEdit: (draft) => runEdit(draft, gateDeps),
    runFinalEdit: (article) => runFinalEdit(article, gateDeps),
  };

  // ── 10. discovery deps = blogDeps + the discovery-specific gathers + knobs.
  const discoveryDeps: DiscoveryDeps & SectionWriterDeps & AssemblyDeps = {
    ...blogDeps,
    gatherSignal: () => source.gatherSignal(),
    gatherCoveredTopics,
    embedDedupSurvivors,
    getRunId: () => ctx.runId,
    onEvent: async (event) => onEvent?.(event),
    dedupThreshold: knobs.dedupThreshold,
    embedDedupSim: knobs.embedDedupSim,
    // Publication identity threading — the engine bakes no domain/publication
    // text into prompts; unset BrandProfile fields resolve to neutral defaults.
    desk: brand.desk ?? `a ${brand.beat} publication`,
    signalLabel:
      brand.signalDescriptor ??
      "our LIVE first-party data signal — what is happening right now in this domain",
    signalHeading: brand.signalHeading ?? "SIGNAL",
    audience: brand.audience ?? `professionals working in ${brand.beat}`,
    categories: brand.categories ?? [
      "news",
      "analysis",
      "feature",
      "profile",
      "explainer",
    ],
    discoveryQueries: knobs.discoveryQueries,
    newsCompanies: knobs.newsCompanies,
    maxSections: knobs.maxSections,
    sectionQueries: knobs.sectionQueries,
    researchConcurrency: knobs.researchConcurrency,
    snippetsPerQuery: knobs.snippetsPerQuery,
    rssPerCompany: knobs.rssPerCompany,
  };

  // ── 11. the full PipelineDeps tail — text defaults + meta regexes + knobs +
  //      the optional enrichment (omitted → neutralEnrichment()).
  const pipelineDeps: PipelineDeps<PipelineBoardCompany> = {
    llm,
    model,
    withRetry,
    gateDeps,
    blogDeps,
    ctx,
    enrichment: opts.enrichment,
    stripPreambleAndFence,
    isArticleShaped,
    lengthSafe,
    countVagueBanding,
    dropDuplicateSentences,
    findRepeatedShingles,
    shingleOccurrences,
    emdashClusteredLines,
    recordArtifact,
    onEvent: async (event) => onEvent?.(event),
    metaProseRe: META_PROSE_RE,
    cotPrefixRe: COT_PREFIX_RE,
    preambleLineRe: PREAMBLE_LINE_RE,
    brandName: brand.name,
    researchPersistChars: knobs.researchPersistChars,
    repeatShingleWords: knobs.repeatShingleWords,
    repeatTrigger: knobs.repeatTrigger,
    sentenceDedupMinChars: knobs.sentenceDedupMinChars,
    clauseDedupMinChars: knobs.clauseDedupMinChars,
    emdashMaxEnv: knobs.emdashMaxEnv,
    tableMinFigures: knobs.tableMinFigures,
    attribTagMax: knobs.attribTagMax,
    draftWordWarnFloor: knobs.draftWordWarnFloor,
  };

  // ── 12. Phase-2 generation — the REAL runGeneration, board generic bound here.
  const generate = (plan: Plan): Promise<GeneratedArticle> =>
    runGeneration(plan, pipelineDeps);

  // ── 13. slugify — lowercase, strip diacritics, collapse to hyphens, cap 80.
  const slugify = (title: string): string =>
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

  // ── 14. finalizePost — wrap the article in the GeneratedPost envelope with a
  //      random byline + the live run telemetry snapshot.
  const finalizePost = (
    article: GeneratedArticle,
    slug: string,
    topic: string,
  ): GeneratedPost => ({
    slug,
    title: article.title,
    markdown: article.content,
    description: article.description,
    byline: brand.bylines[Math.floor(Math.random() * brand.bylines.length)],
    telemetry: { topic, ...ctx.telemetry },
  });

  // ── 15. the carrier.
  return { discoveryDeps, generate, slugify, finalizePost };
}
