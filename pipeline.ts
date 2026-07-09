/**
 * ai-journalist — the section-research → gate-chain → finished-article ORCHESTRATOR.
 *
 * `runGeneration(plan, deps)` is the carved body of the host adapter's old
 * `runPipeline(plan)` (the ~705-line orchestration): synthesize the title Angle →
 * enrich (first-party board data) → write each section (research + write) →
 * assemble + editor tie-together → the deterministic gate chain (fact-guard →
 * ~9 inline surgical-fix passes → headline → entity-link → SEO → CTA →
 * link-integrity) → return the publish-ready article. The PUBLISH decision +
 * persist live in the adapter's main(), unchanged — this returns the Article.
 *
 * Engine-pure: imports ONLY sibling engine modules (./assembly, ./section-writer,
 * ./gates, ./planning, ./ports, ./run-context, ./text) — NOTHING from a host app,
 * ORM, or framework. Every proprietary coupling is injected through
 * `PipelineDeps`:
 *   - The single LLM client (`deps.llm`, wrapping the adapter's chatCompletion) +
 *     `deps.withRetry` drive the 9 inline surgical-fix passes (em-dash / table /
 *     repetition / attribution / banding / etc.) — same messages, byte-identical
 *     prompts (locked by pipeline.checks.ts).
 *   - `deps.gateDeps` carries the gate passes already moved into ./gates (8c);
 *     this calls runFactGuard/runTitle/runSeo/runFactCheckAudit through it.
 *   - The host's DATA + LINK + TELEMETRY tail stays adapter-side and is
 *     injected: the first-party data gathers, the US-government primary block,
 *     entity-resolve, the three linkers (linkEntities / withInternalLinks /
 *     enforceLinkIntegrity), the artifact + run-log writers, and the pure
 *     text/format helpers the adapter still owns (lengthSafe /
 *     stripPreambleAndFence / boardJobsLine / …).
 *   - `deps.ctx` is a per-run telemetry carrier exposed via a getter on the
 *     adapter side (resetRunState swaps it between scheduler runs).
 *
 * Behavior-preserving: the orchestration flow, prompt text, thresholds, and call
 * order are byte-for-byte the old runPipeline — only the couplings became
 * injected. The golden guard replays the whole pipeline end-to-end through this.
 */
import { themeOf, type Plan } from "./planning";
import { type LlmClient } from "./ports";
import { type RunContext } from "./run-context";
import { type BlogRunEvent } from "./discovery";
import {
  type GateDeps,
  type SeoMeta,
  type TitleAngle,
  runFactGuard,
  runFactCheckAudit,
  runTitle,
  runSeo,
} from "./gates";
import { assemble, tieTogether, type AssemblyDeps } from "./assembly";
import {
  writeAllSections,
  writeOneSection,
  type SectionWriterDeps,
} from "./section-writer";
import {
  splitSentences,
  extractFigures,
  countHeadings,
  tableRowCount,
  parseUsDate,
  convertPairedEmdashParentheticals,
  dropRepeatedClauses,
} from "./text";

// ───────────────────────────────────────────────────────────────────────────
// Structural data shapes the orchestrator reads. The adapter's concrete
// first-party-data types (CompanyFreshJobs / LinkEntity / SiteData — which carry
// the adapter's own industry enum) structurally satisfy these, so the engine
// never imports the enum.
// ───────────────────────────────────────────────────────────────────────────

/** A linkable on-site entity (the adapter's first-party-data `LinkEntity`). */
export interface PipelineLinkEntity {
  name: string;
  url: string;
}

/** One company's live board data — the FIELDS the orchestrator reads (the
 *  adapter's first-party-data `CompanyFreshJobs` carries these plus `companySlug`,
 *  `industry`, and `jobs[].slug`). `PipelineDeps`/`runGeneration` are generic
 *  over the adapter's concrete board type (`TBoard extends PipelineBoardCompany`)
 *  so the richer type round-trips through the board-typed deps WITHOUT a cast or
 *  the engine importing the adapter's industry enum; `boardJobsLine`
 *  (injected) formats the fields the engine doesn't read. */
export interface PipelineBoardCompany {
  company: string;
  url: string;
  addedInWindow: number;
  jobs: {
    title: string;
    location: string | null;
    salary: string | null;
  }[];
}

/** First-party site inventory totals (the adapter's first-party-data `SiteData`). */
export interface PipelineSiteData {
  companies: PipelineLinkEntity[];
  people: PipelineLinkEntity[];
  jobCount: number;
  companyCount: number;
  domain: { label: string };
}

/** Companies + people the deterministic linker draws candidates from. */
export interface PipelineLinkable {
  companies: PipelineLinkEntity[];
  people: PipelineLinkEntity[];
}

/** The publish-ready article the orchestrator returns (the adapter's `Article`). */
export interface GeneratedArticle {
  title: string;
  description: string;
  category: string;
  tags: string[];
  keywords: string[];
  seoTitle?: string;
  seoDescription?: string;
  content: string;
}

/**
 * OPTIONAL domain enrichment — the host's first-party data gathers, the
 * entity-link tail, and the jobs-flavored formatting helpers, grouped so the
 * CORE writing pipeline (section research → draft → gate chain) runs without
 * any of it. Omit `PipelineDeps.enrichment` and `runGeneration` binds
 * `neutralEnrichment()`: empty site data, no fresh-hirer/board block, identity
 * linking, pass-through integrity gate. Supply it and behavior is byte-for-byte
 * what the pre-split engine did.
 */
export interface PipelineEnrichment<TBoard extends PipelineBoardCompany> {
  // ── first-party DATA (the host's first-party data gathers) ──
  gatherSiteData: (
    category: string,
    limit: number,
  ) => Promise<PipelineSiteData>;
  gatherLinkableEntities: (
    category: string,
    companyLimit: number,
    peopleLimit: number,
  ) => Promise<PipelineLinkable>;
  gatherIndustryFreshHirers: (
    category: string,
    limit: number,
    windowHours: number,
  ) => Promise<PipelineLinkEntity[]>;
  gatherCompanyFreshJobs: (
    companies: PipelineLinkEntity[],
    perCompany: number,
    windowHours: number,
  ) => Promise<TBoard[]>;
  gatherDatagodFacts: (
    category: string,
    companies: string[],
  ) => Promise<string>;

  // ── entity-linking + integrity tail (the host's data/link/telemetry side) ──
  resolveArticleEntities: (
    article: string,
    boardData: TBoard[],
    withRetry: <T>(
      label: string,
      fn: () => Promise<T>,
      opts?: { input?: string },
    ) => Promise<T>,
  ) => Promise<PipelineLinkEntity[]>;
  linkEntities: (content: string, entities: PipelineLinkEntity[]) => string;
  withInternalLinks: (
    article: GeneratedArticle,
    boardCompanies: PipelineLinkEntity[],
  ) => GeneratedArticle;
  /** Final relative-link gate. `stats` is opaque (the engine only stuffs it into
   *  telemetry) so the adapter's concrete LinkIntegrityStats binds cast-free. */
  enforceLinkIntegrity: (content: string) => Promise<{
    content: string;
    stats: unknown;
  }>;

  // ── jobs-flavored format helpers (host-free) ──
  /** Format one company's board line (adapter's boardJobsLine). */
  boardJobsLine: (b: TBoard) => string;
  /** US-lean location filter (adapter's usLeanLocations). */
  usLeanLocations: (locations: string[]) => boolean;
  /** Short corporate-suffix form of a name, or null (adapter's shortForm). */
  shortForm: (name: string) => string | null;

  // ── name stoplist ──
  /** Short ambiguous names never linked/matched (adapter's LINK_NAME_STOPLIST). */
  linkNameStoplist: ReadonlySet<string>;

  // ── env knobs (the BLOG_* enrichment/linking tuning values) ──
  enrichLimit: number;
  linkCompanyLimit: number;
  linkPeopleLimit: number;
  topicCompanies: number;
  topicCompanyJobs: number;
  topicJobsWindowHours: number;
}

/** The no-op enrichment `runGeneration` uses when `deps.enrichment` is omitted. */
export function neutralEnrichment<
  TBoard extends PipelineBoardCompany,
>(): PipelineEnrichment<TBoard> {
  return {
    gatherSiteData: async () => ({
      companies: [],
      people: [],
      jobCount: 0,
      companyCount: 0,
      domain: { label: "" },
    }),
    gatherLinkableEntities: async () => ({ companies: [], people: [] }),
    gatherIndustryFreshHirers: async () => [],
    gatherCompanyFreshJobs: async () => [],
    gatherDatagodFacts: async () => "",
    resolveArticleEntities: async () => [],
    linkEntities: (content) => content,
    withInternalLinks: (article) => article,
    enforceLinkIntegrity: async (content) => ({ content, stats: null }),
    boardJobsLine: () => "",
    usLeanLocations: () => true,
    shortForm: () => null,
    linkNameStoplist: new Set<string>(),
    enrichLimit: 0,
    linkCompanyLimit: 0,
    linkPeopleLimit: 0,
    topicCompanies: 0,
    topicCompanyJobs: 0,
    topicJobsWindowHours: 0,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The injected couplings. Everything host-resident that the orchestration body
// touches, plus the env knobs + the three meta-prose regexes (shared with the
// adapter's pure helpers). The engine calls each as an opaque reference, so the
// private side can never leak into this module.
// ───────────────────────────────────────────────────────────────────────────
export interface PipelineDeps<TBoard extends PipelineBoardCompany> {
  // ── LLM + retry (the 9 inline surgical-fix passes) ──
  /** The shared OpenRouter-backed client (wraps the adapter's chatCompletion). */
  llm: LlmClient;
  /** BLOG_LLM_MODEL — the adapter's `MODEL`. */
  model: string;
  /** The adapter's retry+telemetry wrapper — exact signature. */
  withRetry: <T>(
    label: string,
    fn: () => Promise<T>,
    opts?: { input?: string; maxAttempts?: number },
  ) => Promise<T>;

  // ── the moved gate passes (8c) + the per-run telemetry carrier ──
  /** The gate-pass couplings (./gates); runFactGuard/runTitle/runSeo use it. */
  gateDeps: GateDeps;
  /** The section/discovery/assembly children's deps (writeOneSection uses it). */
  blogDeps: SectionWriterDeps & AssemblyDeps & { onError: BlogOnError };
  /** Per-run telemetry/artifact carrier (a getter on the adapter — always LIVE). */
  ctx: RunContext;

  /** Optional domain enrichment (data gathers + link tail + jobs helpers).
   *  Omitted → `neutralEnrichment()`: the core pipeline writes without it. */
  enrichment?: PipelineEnrichment<TBoard>;

  // ── pure text/format helpers the adapter still owns (host-free) ──
  /** Strip a surgical pass's preamble/bulk-fence (adapter's stripPreambleAndFence). */
  stripPreambleAndFence: (text: string) => string;
  /** Is the candidate still article-shaped vs its reference (adapter's isArticleShaped). */
  isArticleShaped: (candidate: string, reference: string) => boolean;
  /** Keep a surgical fix only if it stayed 70–130% of input (adapter's lengthSafe). */
  lengthSafe: (label: string, input: string, output: string) => string;
  /** Count vague pay-banding phrases (adapter's countVagueBanding). */
  countVagueBanding: (text: string) => number;
  /** Delete later duplicate sentences (adapter's dropDuplicateSentences). */
  dropDuplicateSentences: (
    text: string,
    minChars: number,
  ) => { text: string; dropped: number };
  /** Distinct repeated word-shingles (adapter's findRepeatedShingles). */
  findRepeatedShingles: (text: string, size: number) => string[];
  /** Context quotes for a normalized shingle (adapter's shingleOccurrences). */
  shingleOccurrences: (text: string, shingle: string, pad: number) => string[];
  /** Sentences carrying ≥3 em-dashes (adapter's emdashClusteredLines). */
  emdashClusteredLines: (text: string) => number;

  // ── artifact + run-log telemetry (the host's telemetry side) ──
  /** Record a per-stage artifact (adapter's recordArtifact → ctx). */
  recordArtifact: (
    stage: string,
    input: string | null,
    output: string,
    stat?: { promptTokens?: number; completionTokens?: number; ms?: number },
  ) => void;
  /** Persist a run event (adapter's run-event logger). Best-effort. Reuses the
   *  engine's `BlogRunEvent` (the same shape discovery.ts/section-writer emit). */
  onEvent: (event: BlogRunEvent) => Promise<void>;

  // ── meta-prose regexes ──
  /** Meta-prose ("here are the checks…") signature. */
  metaProseRe: RegExp;
  /** Chain-of-thought prefix signature ("Let me identify…"). */
  cotPrefixRe: RegExp;
  /** Explicit hand-off preamble line signature. */
  preambleLineRe: RegExp;

  // ── brand ──
  /** Short brand name woven into the first-party-data prompt strings
   *  (BrandProfile.name) — e.g. "Example News". */
  brandName: string;

  // ── env knobs (the BLOG_* tuning values the body reads) ──
  researchPersistChars: number;
  repeatShingleWords: number;
  repeatTrigger: number;
  sentenceDedupMinChars: number;
  clauseDedupMinChars: number;
  /** BLOG_EMDASH_MAX override, or null for the per-length default (the body
   *  reads it via `?? Math.max(...)`, so null/undefined are equivalent here). */
  emdashMaxEnv: number | null;
  tableMinFigures: number;
  attribTagMax: number;
  draftWordWarnFloor: number;
}

/** The adapter's logBlogError signature (section-writer's onError). */
type BlogOnError = (
  phase: string,
  error: unknown,
  context?: Record<string, unknown>,
) => void;

/**
 * Run the section-research pipeline → a publish-ready Article (with footer).
 * Phase 1 (discovery) ran upstream in the adapter's main; this consumes the
 * resulting plan: enrich → first-party board data → write each section (research
 * + write) → assemble → editor tie-together → the existing gate chain (unchanged).
 *
 * Generic over the adapter's concrete board-company type (`TBoard`) so its
 * richer `CompanyFreshJobs` round-trips through the board-typed deps without a
 * cast or the engine importing the adapter's industry enum (inferred from `deps`).
 */
export async function runGeneration<TBoard extends PipelineBoardCompany>(
  plan: Plan,
  deps: PipelineDeps<TBoard>,
): Promise<GeneratedArticle> {
  const ctx = deps.ctx;
  // Optional domain enrichment — omitted → the no-op preset, so the CORE
  // writing pipeline runs without any first-party data / link tail / jobs helpers.
  const enr = deps.enrichment ?? neutralEnrichment<TBoard>();
  const {
    llm,
    withRetry,
    gateDeps,
    blogDeps,
    stripPreambleAndFence,
    isArticleShaped,
    lengthSafe,
    countVagueBanding,
    dropDuplicateSentences,
    findRepeatedShingles,
    shingleOccurrences,
    emdashClusteredLines,
    recordArtifact,
    brandName,
  } = deps;
  // Thread this run's MAIN THEME into gateDeps. Set on the SHARED object (not a
  // spread copy): the edit passes (runEdit/runFinalEdit) reach gates.ts through
  // closures the preset/adapter pre-bound over this exact object, so only an
  // in-place field lets every gate pass — including those closures — read it.
  gateDeps.theme = themeOf(plan);
  const { boardJobsLine, usLeanLocations, shortForm } = enr;
  const MODEL = deps.model;
  const META_PROSE_RE = deps.metaProseRe;
  const COT_PREFIX_RE = deps.cotPrefixRe;
  const PREAMBLE_LINE_RE = deps.preambleLineRe;
  const LINK_NAME_STOPLIST = enr.linkNameStoplist;
  const topic = plan.title;
  const category = plan.category ?? "frontier";
  // Synthesize the Angle the downstream title + CTA passes still consume (the
  // per-topic Angle pass is gone — the plan carries angle + category directly).
  const angle: TitleAngle = {
    category,
    angle: plan.angle,
    // Short 2-4 word seed for the headline pass's autocomplete grounding — the
    // plan's searchSeed, or the title's leading words as a fallback. (Feeding
    // the whole title here autocompletes to nothing and de-grounds the headline.)
    searchSeed:
      plan.searchSeed?.trim() || topic.split(/\s+/).slice(0, 4).join(" "),
  };
  process.stdout.write(`        category=${category} — ${plan.angle}\n`);

  process.stdout.write(
    "  [1/6] enrich (real site data + link candidates)...\n",
  );
  const [site, linkable] = await Promise.all([
    enr.gatherSiteData(category, enr.enrichLimit),
    enr.gatherLinkableEntities(
      category,
      enr.linkCompanyLimit,
      enr.linkPeopleLimit,
    ),
  ]);
  process.stdout.write(
    `        ${site.companies.length} featured companies, ${site.people.length} people, ${site.jobCount} jobs; ` +
      `${linkable.companies.length}+${linkable.people.length} link candidates\n`,
  );
  // Companies named in the PLAN (title + angle + section headings/intents) get
  // their live postings fed to the sections as citable first-party data — an
  // article about a company's hiring should cite the site's own fresh postings,
  // not only third-party counts. Case-sensitive proper-noun match over the plan's
  // sentence-case text; matched companies feed the section board-facts AND the
  // closing CTA, so prose-colliding short names are excluded via the same
  // stoplist the entity-linker uses (R6C9: "Boom" matched "…Automation Boom…").
  const planText = `${plan.title} ${plan.angle} ${plan.sections
    .map((s) => `${s.heading} ${s.intent}`)
    .join(" ")}`;
  const escapeRe = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matchesPlan = (name: string): boolean =>
    new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`).test(planText);
  const namedCompanies = linkable.companies
    .filter((c) => {
      const name = c.name.trim();
      // Distinctive short names (mixed-case/digit: xAI, C3i) are structurally
      // unambiguous to the case-sensitive matchers — exempt from the floor.
      const distinctive = /[a-z][A-Z]|\d/.test(name);
      if (name.length < 4 && !distinctive) return false;
      if (LINK_NAME_STOPLIST.has(name)) return false;
      if (matchesPlan(name)) return true;
      const short = shortForm(name);
      return (
        short !== null && !LINK_NAME_STOPLIST.has(short) && matchesPlan(short)
      );
    })
    .slice(0, enr.topicCompanies);
  // Fallback: when the topic names no board company (cycle 6's drone-delivery
  // piece named none), feed the article-category's top fresh hirers instead —
  // every article gets citable first-party data, not just company-named ones.
  // Fetch extra fallback candidates, then US-lean-filter on their actual job
  // locations (cycle 7: a French care startup ranked #2 in "frontier").
  const usingFallback = namedCompanies.length === 0;
  const companiesForBoard = usingFallback
    ? await enr.gatherIndustryFreshHirers(
        angle.category,
        enr.topicCompanies + 2,
        enr.topicJobsWindowHours,
      )
    : namedCompanies;
  let boardData = companiesForBoard.length
    ? await enr.gatherCompanyFreshJobs(
        companiesForBoard,
        enr.topicCompanyJobs,
        enr.topicJobsWindowHours,
      )
    : [];
  if (usingFallback) {
    boardData = boardData
      .filter((b) =>
        usLeanLocations(
          b.jobs.map((j) => j.location ?? "").filter((l) => l !== ""),
        ),
      )
      .slice(0, enr.topicCompanies);
  }
  if (boardData.length) {
    process.stdout.write(
      `        live board data: ${boardData
        .map((b) => `${b.company} (${b.addedInWindow} added/7d)`)
        .join(", ")}\n`,
    );
  }
  // US-government primary data (the host's primary-source gateway: USAspending
  // federal awards for the named companies + the category's verified BLS labor
  // series) — tier-1 grounding for the contract and wage figures the press re-tells.
  // Best-effort: "" when keyless or failed; appended to BOTH the verified
  // facts (so outline + draft can use it) and the ground truth (so citing it
  // passes the figure gate and the fact-guard's primary-source rule).
  const datagodBlock = await enr.gatherDatagodFacts(
    category,
    // The US-lean-FILTERED board companies, not the raw candidate list
    // (R7C3: fallback-mode fed ASML/Ouihelp → exact-but-irrelevant awards).
    // Empty → awards skipped, BLS kept.
    boardData.map((b) => b.company),
  );
  if (datagodBlock) {
    process.stdout.write(
      `        datagod: US-government primary block (${datagodBlock.length} chars)\n`,
    );
  }
  // Persist for post-hoc audits (R7C5: a synthesized award total was
  // unreconstructable because this block lived only in-flight).
  ctx.telemetry.datagodBlock = datagodBlock || undefined;
  // First-party board facts, pre-formatted for the section writer (the same
  // data the old single-prompt draft injected as its boardBlock).
  const boardFacts = boardData.length
    ? boardData.map((b) => `- ${b.company}: ${boardJobsLine(b)}`).join("\n")
    : "";

  // [2/6] Phase 2 — research + write each section (bounded parallel). Each
  // section deep-researches its own queries; the pooled research becomes the
  // gate chain's ground truth (the per-section research IS the verified corpus,
  // replacing the old separate fact-check pass).
  process.stdout.write(
    `  [2/6] writing ${plan.sections.length} sections (research + write)...\n`,
  );
  const sections = await writeAllSections(
    plan,
    // Part C: the digest deps ride blogDeps through this binding — the run's
    // generalDigest (built by the entry from the discovery corpus) plus the
    // host's digestSection/retryThin reach writeOneSection here; all absent →
    // the legacy raw-research prompt, byte-identical.
    (p, i) => writeOneSection(p, i, boardFacts, blogDeps),
    blogDeps.onError,
    blogDeps.sectionConcurrency,
  );
  const research = sections.research;
  const facts = research;
  // Persist the pooled research corpus (separate row, rawData lazy-loads in the
  // admin detail view) so every published claim can be audited against what the
  // model was actually given. Best-effort write.
  await deps.onEvent({
    runId: ctx.runId,
    company: "blog_generator",
    event: "fetch_complete",
    status: "info",
    message: `Section research pooled (${research.length} chars across ${plan.sections.length} sections) — audit article claims against rawData`,
    rawData: { research: research.slice(0, deps.researchPersistChars) },
    metadata: { sections: plan.sections.map((s) => s.heading) },
  });

  // [3/6] Phase 3 — assemble the sections + editor tie-together (smooth
  // transitions, kill cross-section repetition, enforce one voice/arc).
  process.stdout.write("  [3/6] assemble + editor tie-together...\n");
  const assembledDraft = assemble(plan, sections.markdowns);
  const finalEdited = await tieTogether(assembledDraft, blogDeps);
  if (!finalEdited.trim())
    throw new Error("Pipeline produced an empty article");
  process.stdout.write(
    "  [4/6] fact-guard (strip unsupported individuals)...\n",
  );
  // The guard's ground truth must include the brand's OWN board data — without it the
  // guard strips first-party citations ("<brand>'s board lists 215
  // Anduril roles") as unsupported numbers (it did exactly that in cycle 5).
  // Formatting goes through boardJobsLine — field parity with the draft's
  // boardBlock (R7C2: boardTruth carried titles only, so the grounding gate
  // stripped 22 TRUE first-party salaries the draft legitimately printed).
  const boardFactsTruth = boardData.length
    ? `\n\n## FIRST-PARTY BOARD DATA (${brandName}'s own job board — verified, ingested directly from company ATSes; citations of these figures are grounded)\n\n${boardData
        .map((b) => `${b.company}: ${boardJobsLine(b)}`)
        .join("\n")}`
    : "";
  // Site-inventory totals are first-party too, and ALWAYS in the draft prompt
  // ("<brand> tracks N open roles across M companies") — drafts cite them
  // legitimately, but they were absent from groundTruth, so the grounding
  // gate flagged e.g. "11,475" as ungrounded. Skipped when the host supplies no
  // site data (neutral enrichment): an all-zeros "tracks 0 open roles across 0
  // companies" line would inject a false "verified" fact into the ground truth.
  const siteInventoryTruth =
    site.jobCount > 0 || site.companyCount > 0
      ? `\n\n## FIRST-PARTY SITE INVENTORY (${brandName}'s own totals — verified): ${brandName} tracks ${site.jobCount} open ${site.domain.label} roles across ${site.companyCount} companies; the site features ${site.companies.length} companies and ${site.people.length} notable people in this domain.`
      : "";
  const boardTruth = `${boardFactsTruth}${siteInventoryTruth}`;
  // Validate the guard's output IS still the article (R6C3: it returned its
  // own QA report — "Here are the specific checks I performed: 1..." — and the
  // 343-word checklist published as the body). Retry once; if still
  // report-shaped, fall back to the pre-guard article rather than persist a
  // non-article.
  let guarded = stripPreambleAndFence(
    await runFactGuard(
      finalEdited,
      research + datagodBlock + boardTruth,
      gateDeps,
    ),
  );
  if (!isArticleShaped(guarded, finalEdited)) {
    process.stdout.write(
      "        fact-guard returned a non-article (report-shaped) — retrying...\n",
    );
    // Retry against the DISTILLED ground truth (R7C8: the identical
    // 140k-token prompt predictably collapsed identically; small-prompt
    // surgical passes succeeded 7/7 the same run). Fact-check output +
    // first-party blocks carry every verified fact at ~1/10 the tokens.
    guarded = stripPreambleAndFence(
      await runFactGuard(
        finalEdited,
        `${facts}\n${datagodBlock}\n${boardTruth}\n\nFORMAT STRESS: output ONLY the corrected markdown article — the FIRST line of your output must be the first line of the article body. No analysis, no checklists, no preamble of any kind.`,
        gateDeps,
      ),
    );
    if (!isArticleShaped(guarded, finalEdited)) {
      process.stdout.write(
        "        fact-guard non-article twice — FALLING BACK to pre-guard article (recorded, publish-blocking)\n",
      );
      guarded = finalEdited;
      ctx.recordRetry({
        label: "fact-guard-fallback",
        attempt: 2,
        error: "guard output report-shaped twice; used pre-guard article",
      });
      // An UNGUARDED article must never auto-publish (R7C8: the fabricated
      // thesis shipped in the exact run where the guard was down).
      ctx.telemetry.article = {
        ...(ctx.telemetry.article ?? {}),
        unguarded: true,
      };
    }
  }
  let grounded = guarded;
  const groundTruth = research + datagodBlock + boardTruth;
  // Deterministic vague-banding budget (R6C2: the grounding fix softened to
  // 10+ "pays well"-class hand-waves instead of substituting, shipping a
  // salary story with one salary — the ≤3 rule was unenforced prose).
  for (
    let vague = countVagueBanding(grounded), pass = 1;
    vague > 3 && pass <= 2;
    pass++
  ) {
    process.stdout.write(
      `        ${vague} vague pay-banding phrases — substitution fix (${pass})...\n`,
    );
    const input = grounded;
    grounded = lengthSafe(
      "banding-fix",
      input,
      await withRetry("banding-fix", () =>
        llm.complete({
          prompt: `This article hand-waves about pay ${vague} times ("pays well", "competitive salaries", "strong wages", "six figures" and similar) instead of stating figures. Replace each vague pay phrase with a SPECIFIC figure or range from the RESEARCH below, correctly attributed — or cut the sentence if the research truly has no figure for that subject. At most THREE vague pay phrases may remain in the whole article. Change NOTHING else: every other word, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.\n\nRESEARCH (source figures from here — FIRST-PARTY and government blocks lead):\n${datagodBlock}\n${boardTruth}\n${research.slice(0, Math.max(0, 60000 - datagodBlock.length - boardTruth.length))}\n\nARTICLE:\n${input}`,
          model: MODEL,
          temperature: 0.3,
        }),
      ),
    );
    vague = countVagueBanding(grounded);
    if (vague > 3 && pass === 2) {
      process.stdout.write(
        `        still ${vague} vague phrases after 2 passes — accepting\n`,
      );
    }
  }
  // Deterministic repetition detector (cycle 6: five 6-word phrases shipped
  // verbatim-doubled despite three prompt rules). Detect in code; one surgical
  // dedupe pass naming the exact phrases.
  let deduped = grounded;
  const repeated = findRepeatedShingles(deduped, deps.repeatShingleWords);
  // Verify-and-retry once, like the attribution loop — a single dedupe pass is
  // lossy (cycle 8: 21 phrases → ~3 survived one pass).
  let escalate = false;
  for (
    let phrases = repeated, pass = 1;
    phrases.length > deps.repeatTrigger && pass <= 2;
    pass++
  ) {
    process.stdout.write(
      `        ${phrases.length} repeated phrases — dedupe pass (${pass})${escalate ? " [enumerated escalation]" : ""}...\n`,
    );
    const shinglesBefore = phrases.length;
    const input = deduped;
    // Round-8 #4 escalation (R7C9: pass 1 returned the article unchanged —
    // 48→48 — and a verbatim award-triplet shipped twice; R6C9's attribution
    // pass proved ENUMERATION flips owl-alpha from no-op to compliant): after
    // a no-op pass 1, pass 2 swaps the abstract phrase list for the top-10
    // repeated families (ranked by length × count) quoting BOTH occurrences
    // with surrounding context.
    const escalated = escalate
      ? phrases
          .map((p) => ({ p, occ: shingleOccurrences(input, p, 40) }))
          .filter((f) => f.occ.length >= 2)
          .sort((a, b) => b.p.length * b.occ.length - a.p.length * a.occ.length)
          .slice(0, 10)
      : [];
    const prompt =
      escalated.length > 0
        ? `The previous dedupe pass returned this article unchanged. Here are the ${escalated.length} worst repeated phrasings (ranked by length × count), each quoted at BOTH occurrences with surrounding context. Keep each one's FIRST occurrence exactly as written and rework the SECOND (and any later) occurrence to reference the fact without repeating the phrasing — shorten it, use a pronoun, or fold it into the surrounding sentence. Change NOTHING else: every other word, number, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.\n\nREPEATED FAMILIES:\n${escalated
            .map(
              (f, i) =>
                `${i + 1}. "${f.p}" (${f.occ.length}×)\n   first:  "…${f.occ[0]}…"\n   second: "…${f.occ[1]}…"`,
            )
            .join("\n")}\n\nARTICLE:\n${input}`
        : `Each of these phrases appears more than once in the article. Keep each one's STRONGEST occurrence and rework every other occurrence to reference the fact without repeating the phrasing (shorten it, use a pronoun, or fold it into context). Change NOTHING else: every other word, number, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.\n\nREPEATED PHRASES:\n${phrases
            .map((p) => `- "${p}"`)
            .join("\n")}\n\nARTICLE:\n${input}`;
    deduped = lengthSafe(
      "repetition-fix",
      input,
      await withRetry("repetition-fix", () =>
        llm.complete({
          prompt,
          model: MODEL,
          temperature: 0.3,
        }),
      ),
    );
    phrases = findRepeatedShingles(deduped, deps.repeatShingleWords);
    if (pass === 1 && phrases.length === shinglesBefore) {
      // Exact no-op (the R7C9 class): escalate pass 2 with enumerated
      // occurrences instead of skipping it as non-converging.
      escalate = true;
      process.stdout.write(
        `        repetition pass 1 was a no-op (${shinglesBefore}→${phrases.length}) — escalating pass 2 with enumerated occurrences\n`,
      );
    } else if (pass === 1 && phrases.length > shinglesBefore * 0.8) {
      process.stdout.write(
        `        repetition fix non-converging (${shinglesBefore}→${phrases.length}) — skipping pass 2\n`,
      );
      break;
    }
    if (phrases.length > deps.repeatTrigger && pass === 2) {
      process.stdout.write(
        `        still ${phrases.length} repeated phrases after 2 passes — accepting\n`,
      );
    }
  }
  // Final deterministic guard: whole sentences that STILL repeat get their
  // later occurrence deleted in code — never ship verbatim-duplicated copy.
  {
    const sentenceDedup = dropDuplicateSentences(
      deduped,
      deps.sentenceDedupMinChars,
    );
    if (sentenceDedup.dropped > 0) {
      process.stdout.write(
        `        dropped ${sentenceDedup.dropped} verbatim-duplicate sentence(s) in code\n`,
      );
      deduped = sentenceDedup.text;
    }
    // Round-8 #4 clause backstop (R7C9: the shipped duplicate was an
    // award-triplet CLAUSE embedded in two DIFFERENT sentences — invisible
    // to whole-sentence dedupe). Code-only: drops the later occurrence of
    // any ≥40-char clause bounded by sentence punctuation or line ends;
    // never mid-sentence surgery (text.ts dropRepeatedClauses).
    const clauseDedup = dropRepeatedClauses(deduped, deps.clauseDedupMinChars);
    if (clauseDedup.dropped > 0) {
      process.stdout.write(
        `        dropped ${clauseDedup.dropped} verbatim-duplicate clause(s) in code\n`,
      );
      deduped = clauseDedup.text;
    }
  }
  // Em-dash budget: ~1 per 250 words (floor 6) — only genuinely dash-drunk
  // copy triggers the fix now.
  const emdashCap =
    deps.emdashMaxEnv ??
    Math.max(6, Math.round(deduped.split(/\s+/).length / 250));
  // Count only CONVERTIBLE prose dashes — headings/tables/quotes are exempt
  // from conversion, so counting them chases an unreachable number (R7C4:
  // "12 vs cap 8" was really 9 vs 8; two passes + fallback burned).
  const countProseDashes = (t: string): number =>
    (
      t
        .split("\n")
        .filter((l) => !/^\s*(?:\||#{1,6}\s|>)/.test(l))
        .join("\n")
        .match(/—/g) ?? []
    ).length;
  for (
    let emDashes = countProseDashes(deduped), pass = 1;
    emDashes > emdashCap && pass <= 2;
    pass++
  ) {
    process.stdout.write(
      `        ${emDashes} em-dashes (cap ${emdashCap}) — punctuation fix (${pass})...\n`,
    );
    const emdashBefore = emDashes;
    const input = deduped;
    // ENUMERATE the exact dash-carrying sentences (R7 redesign: 4+ cycles of
    // whole-article "rewrite excess dashes" prompts were no-ops; the
    // attribution pass proved enumeration flips owl-alpha from no-op to
    // compliant). Table lines are excluded — "—" is the empty-cell marker
    // there, not punctuation.
    const offending = splitSentences(
      input
        .split("\n")
        .filter((line) => !/^\s*\|/.test(line))
        .join("\n"),
    ).filter((s) => s.includes("—"));
    deduped = lengthSafe(
      "emdash-fix",
      input,
      await withRetry("emdash-fix", () =>
        llm.complete({
          prompt: `This article uses the em-dash (—) ${emDashes} times; at most ${emdashCap} may remain. These are the exact sentences carrying them — rewrite ONLY these sentences, converting excess em-dashes into a comma, period, parentheses, or a restructured sentence, keeping only the ${emdashCap} strongest across the whole article:\n${offending
            .map((s) => `- "${s}"`)
            .join(
              "\n",
            )}\n\nEvery other sentence stays exactly as written: every other word, number, link, and heading unchanged. Output ONLY the full corrected markdown article.\n\nARTICLE:\n${input}`,
          model: MODEL,
          temperature: 0.3,
        }),
      ),
    );
    emDashes = countProseDashes(deduped);
    if (pass === 1 && emDashes > emdashBefore * 0.8) {
      process.stdout.write(
        `        em-dash fix non-converging (${emdashBefore}→${emDashes}) — skipping pass 2\n`,
      );
      break;
    }
  }
  // Deterministic fallback when the LLM passes leave the budget blown: convert
  // PAIRED parenthetical dashes " — X — " → " (X) " right-to-left until the
  // cap holds. Pairs only — a prior pass that deleted a SINGLE dash broke a
  // sentence mid-clause; that risk class is banned (text.ts never touches
  // unpaired dashes, tables, headings, or quotes).
  {
    const emDashesNow = countProseDashes(deduped);
    if (emDashesNow > emdashCap) {
      const fallback = convertPairedEmdashParentheticals(deduped, emdashCap);
      if (fallback.converted > 0) {
        process.stdout.write(
          `        em-dash fallback: converted ${fallback.converted} paired parenthetical(s) to (…)\n`,
        );
        deduped = fallback.text;
      }
      const remaining = countProseDashes(deduped);
      if (remaining > emdashCap) {
        process.stdout.write(
          `        still ${remaining} em-dashes after enumerated passes + fallback — accepting\n`,
        );
      }
    }
  }
  // Table enforcement: a piece carrying a wall of $-figures with zero tables
  // violates the FORMATTING rule (R5C3: six salary bands, prose-only).
  const dollarFigures = new Set(
    (deduped.match(/\$\d[\d,]*k?/gi) ?? []).map((f) => f.replace(/[,.]+$/, "")),
  ).size;
  // AST row count (text.ts): also sees valid GFM tables written WITHOUT
  // leading pipes, which the old `^\|` line count missed — a source of the
  // "table-fix silent no-op" false readings.
  const tableRowsNow = tableRowCount(deduped);
  if (dollarFigures >= deps.tableMinFigures && tableRowsNow === 0) {
    process.stdout.write(
      `        ${dollarFigures} $-figures, 0 tables — table fix...\n`,
    );
    const tableInput = deduped;
    deduped = lengthSafe(
      "table-fix",
      tableInput,
      await withRetry("table-fix", () =>
        llm.complete({
          prompt: `This article presents ${dollarFigures} distinct dollar figures entirely in prose. Convert the COMPARABLE ones (salaries by role, ranges by source, market sizes by firm) into ONE compact markdown table placed at the most natural spot, and trim the prose that merely restates the tabled numbers. Keep non-comparable figures in prose. Change nothing else — every link, heading, and remaining sentence stays exactly as written. Output ONLY the full corrected markdown article.\n\nARTICLE:\n${tableInput}`,
          model: MODEL,
          temperature: 0.3,
        }),
      ),
    );
    // Verify (audit: silent no-op in ≥4 of 7 firings this round): a table-fix
    // that produced no table is recorded for review.
    const rowsAfter = tableRowCount(deduped);
    if (rowsAfter === 0) {
      process.stdout.write(
        `        table-fix produced no table — accepting (recorded)\n`,
      );
      ctx.telemetry.article = {
        ...(ctx.telemetry.article ?? {}),
        tableFixNoOp: true,
      };
    }
  }
  // Deterministic attribution budget — FORM-AGNOSTIC (R6C6: 11 "per X" tags
  // shipped while the literal "according to" counter read 0; the model just
  // migrates to whichever tag form isn't counted). Budget covers both forms.
  const countAttribTags = (s: string): number =>
    // "according to" is always attributive regardless of continuation case
    // (R7C7: "according to 2025 data from…" escaped → 9 reader-visible tags
    // vs budget 4); "per" stays capitalized-only (per day/hour must not count).
    (s.match(/\baccording to\s+\S/gi) ?? []).length +
    (s.match(/\bper\s+[A-Z]/g) ?? []).length;
  const listAttribTags = (s: string): string[] =>
    [...s.matchAll(/\b(?:according to|per)\s+[A-Z][^,.;:\n]*/g)].map(
      (m) => m[0],
    );
  let attributed = deduped;
  const accordingToBeforeFix = countAttribTags(attributed);
  for (
    let count = accordingToBeforeFix, pass = 1;
    count > deps.attribTagMax && pass <= 2;
    pass++
  ) {
    process.stdout.write(
      `        ${count} attribution tags ("according to"/"per X") — attribution fix (pass ${pass})...\n`,
    );
    const input = attributed;
    // Pass 2 enumerates the exact offending tags — owl-alpha returns the
    // article unchanged on abstract minimal-rewrite prompts (R6C9: 7→7→7),
    // but rewrites reliably when shown the literal strings to change.
    const enumerated =
      pass === 2
        ? `\n\nThese are the exact attribution tags currently in the article — rewrite all but ${deps.attribTagMax} of them:\n${listAttribTags(
            input,
          )
            .map((t) => `- "${t}"`)
            .join("\n")}`
        : "";
    attributed = lengthSafe(
      "attribution-fix",
      input,
      await withRetry("attribution-fix", () =>
        llm.complete({
          prompt: `This article uses inline attribution tags ("according to X", "per X") ${count} times; at most ${deps.attribTagMax} may remain. Rewrite ONLY the excess instances into varied attribution — "X reported", "X's data shows", "X found", a possessive ("X's figures put…"), or state the fact and cite the source in a nearby sentence. Change NOTHING else: every other word, number, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.${enumerated}\n\nARTICLE:\n${input}`,
          model: MODEL,
          temperature: 0.3,
        }),
      ),
    );
    count = countAttribTags(attributed);
  }
  if (countAttribTags(attributed) > deps.attribTagMax) {
    // Deterministic fallback for whatever the LLM passes declined: rewrite
    // only the two SAFEST forms — trailing ", according to X." → ", X
    // reports." and sentence-initial "According to X, " → "X reports that "
    // — until the budget holds. Anything still over is accepted (prose
    // surgery beyond these forms risks more than a counted tag costs).
    const remaining = countAttribTags(attributed) - deps.attribTagMax;
    let fixed = 0;
    attributed = attributed.replace(
      /,\s+(?:according to|per)\s+([A-Z][\w&'’. -]*?)\.(\s|$)/g,
      (full, src: string, tail: string) => {
        // Skip spans already carrying attribution verbs (R7C6: "…according
        // to Layoffs.fyi data reported by CNBC." → "… reports." breakage)
        // and rotate forms to avoid 24-fold ", X reports." monotony.
        if (/\b(report|according|per\b|cited|data shows)\b/i.test(src)) {
          return full;
        }
        if (fixed >= remaining) return full;
        const forms = [" reports.", "'s data shows.", " found."];
        const form = forms[fixed % forms.length];
        fixed += 1;
        return `, ${src}${form}${tail}`;
      },
    );
    attributed = attributed.replace(
      /(^|\n)According to\s+([A-Z][\w&'’. -]*?),\s+/g,
      (full, lead: string, src: string) =>
        fixed < remaining
          ? ((fixed += 1), `${lead}${src} reports that `)
          : full,
    );
    if (fixed > 0) {
      process.stdout.write(
        `        attribution: deterministically rewrote ${fixed} excess tag(s)\n`,
      );
    }
    const final = countAttribTags(attributed);
    if (final > deps.attribTagMax) {
      process.stdout.write(
        `        still ${final} attribution tags after fixes — accepting\n`,
      );
    }
  }
  // Attribution FLOOR (round-8 #5 — R7C10: ~30 third-party stats shipped
  // with ZERO named sources; the budget above only CAPS tags, nothing ever
  // required any). Named-source spans = the budgeted tag forms plus the
  // rotation forms the budget passes rewrite INTO ("X reports", "X's data
  // shows", "X found") — counting those keeps the floor from re-flagging a
  // budget-fixed article. House detect → fix → verify; ONE surgical pass,
  // accept + record on miss.
  {
    const countNamedSources = (s: string): number =>
      countAttribTags(s) +
      (s.match(/\b[A-Z][\w&'’.-]*\s+(?:reports?|reported|found)\b/g) ?? [])
        .length +
      (s.match(/\b[A-Z][\w&'’.-]*['’]s\s+data\s+shows\b/g) ?? []).length;
    const figureCount = extractFigures(attributed).filter(
      (f) => f.unit === "USD" || f.unit === "percent",
    ).length;
    const sourcesBefore = countNamedSources(attributed);
    if (figureCount >= 8 && sourcesBefore < figureCount / 8) {
      const wanted = Math.ceil(figureCount / 8) - sourcesBefore;
      process.stdout.write(
        `        ${sourcesBefore} named-source attribution(s) on ${figureCount} USD/percent figures — attribution-floor fix (attribute ${wanted} more)...\n`,
      );
      const input = attributed;
      attributed = lengthSafe(
        "attribution-floor-fix",
        input,
        await withRetry("attribution-floor-fix", () =>
          llm.complete({
            prompt: `This article carries ${figureCount} dollar/percent figures but names almost no sources (${sourcesBefore} named attribution(s) in total) — readers cannot tell where the numbers come from. Attribute the ${wanted} LARGEST claims (the biggest dollar figures, market sizes, and percent swings) to their sources BY NAME, using the RESEARCH below to find which source reported each figure. Vary the forms — "X reported", "X's data shows", "X found", a possessive ("X's figures put…") — and add at most two "according to". If the research truly names no source for a figure, leave that figure alone. Change NOTHING else: every other word, number, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.\n\nRESEARCH (find each figure's source here — FIRST-PARTY and government blocks lead):\n${datagodBlock}\n${boardTruth}\n${research.slice(0, Math.max(0, 60000 - datagodBlock.length - boardTruth.length))}\n\nARTICLE:\n${input}`,
            model: MODEL,
            temperature: 0.3,
          }),
        ),
      );
      const after = countNamedSources(attributed);
      if (after < figureCount / 8) {
        process.stdout.write(
          `        still ${after} named-source attribution(s) after the floor fix — accepting (recorded)\n`,
        );
        ctx.telemetry.article = {
          ...(ctx.telemetry.article ?? {}),
          attributionFloorMiss: true,
        };
      }
    }
  }
  // First-party claim verifier (R7C5: Levels.fyi widget rows shipped as
  // "<brand>'s job board data" with ranges the brand's OWN DB contradicts —
  // brand-falsifying provenance no other gate covers). Every $-figure in a
  // sentence naming the brand must trace to boardTruth alone.
  {
    const boardNorm = boardTruth.replace(/[,\s]/g, "").toLowerCase();
    const brandNameRe = new RegExp(
      brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    const offending = splitSentences(attributed)
      .filter((sent) => brandNameRe.test(sent))
      .filter((sent) =>
        (sent.match(/\$\d[\d,]*(?:\.\d+)?(?:k)?/gi) ?? []).some((f) => {
          const raw = f.replace(/[^0-9.k]/gi, "").toLowerCase();
          const expanded = raw.endsWith("k")
            ? String(Math.round(parseFloat(raw) * 1000))
            : raw.replace(/\./g, "");
          return !boardNorm.includes(expanded) && !boardNorm.includes(raw);
        }),
      );
    if (offending.length > 0) {
      process.stdout.write(
        `        ${offending.length} first-party-claim sentence(s) carry figures not in board data — re-attribution fix...\n`,
      );
      const input = attributed;
      attributed = lengthSafe(
        "firstparty-fix",
        input,
        await withRetry("firstparty-fix", () =>
          llm.complete({
            prompt: `These sentences attribute figures to "${brandName}'s job board", but the figures are NOT in our board data. Re-attribute each to the actual source the research names for those figures, or cut the first-party framing — our board data is ONLY the following:\n${boardTruth}\n\nSentences to fix:\n${offending
              .map((x) => `- "${x.trim()}"`)
              .join(
                "\n",
              )}\n\nChange NOTHING else: every other word, number, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.\n\nARTICLE:\n${input}`,
            model: MODEL,
            temperature: 0.3,
          }),
        ),
      );
    }
  }
  // Stale-date gate (R7C2: an April 21 career fair shipped in FUTURE tense
  // 7 weeks after the event — news-pegged sources predate runs by weeks and
  // no pass compared in-article dates to today). Deterministic detect → one
  // surgical recast pass. Sentence extraction via splitSentences (the old
  // `[^.!?\n]*…[.!?]` pseudo-sentence regex truncated at ANY .!? — including
  // quote-final punctuation — so the recast prompt got fragments, not
  // sentences); date parse via date-fns parseUsDate (strict — no Date()
  // rollover on "April 99").
  {
    const MONTHS =
      "January|February|March|April|May|June|July|August|September|October|November|December";
    const usDateRe = new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},?\\s+\\d{4}\\b`);
    // Day-less form ("February 2026") parses as the month's last week
    // (R7C7: "expected to begin operations in February 2026" shipped in June).
    const usMonthYearRe = new RegExp(`\\b(${MONTHS})\\s+(\\d{4})\\b`);
    const stale = splitSentences(attributed).filter((sent) => {
      if (!/\b(?:will|scheduled|plans? to|upcoming|expected to)\b/.test(sent))
        return false;
      let dateStr = sent.match(usDateRe)?.[0];
      if (!dateStr) {
        const my = sent.match(usMonthYearRe);
        if (my) dateStr = `${my[1]} 28, ${my[2]}`;
      }
      if (!dateStr) return false;
      const d = parseUsDate(dateStr);
      return d !== null && d.getTime() < Date.now() - 86_400_000;
    });
    if (stale.length > 0) {
      process.stdout.write(
        `        ${stale.length} stale future-tense date sentence(s) — recast pass...\n`,
      );
      const input = attributed;
      attributed = lengthSafe(
        "stale-date-fix",
        input,
        await withRetry("stale-date-fix", () =>
          llm.complete({
            prompt: `Today is ${new Date().toDateString()}. These sentences describe PAST events in future tense:\n${stale
              .map((s) => `- "${s.trim()}"`)
              .join(
                "\n",
              )}\n\nRecast ONLY these sentences into past tense (or cut a sentence entirely if it is purely an announcement of the now-passed event). Change NOTHING else: every other word, number, link, and heading stays exactly as written. Output ONLY the full corrected markdown article.\n\nARTICLE:\n${input}`,
            model: MODEL,
            temperature: 0.3,
          }),
        ),
      );
    }
  }
  process.stdout.write("  [5/6] headline (NYT/WSJ candidates -> pick)...\n");
  const { content: titled, title } = await runTitle(
    attributed,
    topic,
    angle,
    groundTruth,
    gateDeps,
  );
  process.stdout.write(`        headline: ${title}\n`);
  process.stdout.write("  [6/6] link + seo...\n");
  // Deterministically link every named on-site company/person — owl-alpha links
  // them unevenly and only knows the Draft pass's handful of slugs.
  // Board-data companies join the linker candidates — theme-driven companies
  // (e.g. a 7-job critical-minerals startup) sit below the top-500-by-hiring
  // cut and were unlinkable despite being the article's subject (R6C6: six
  // named fusion companies, zero links).
  // Augment the deterministic linker with LLM-resolved long-tail entities
  // (companies/people/positions the top-N candidate set misses). Best-effort.
  const resolved = await enr.resolveArticleEntities(
    titled,
    boardData,
    withRetry,
  );
  process.stdout.write(
    `        entity-resolve: +${resolved.length} resolved link candidates\n`,
  );
  const linked = enr.linkEntities(titled, [
    ...linkable.companies,
    ...companiesForBoard.filter(
      (c) => !linkable.companies.some((l) => l.name === c.name),
    ),
    ...linkable.people,
    ...resolved,
  ]);
  const linkCount = (linked.match(/\]\(\/(?:[a-z]+-companies|people)\//g) ?? [])
    .length;
  process.stdout.write(`        ${linkCount} on-site entity links in body\n`);
  // Loud guard: a body whose render would break — leading fence, a fence
  // wrapping the bulk of the body ANYWHERE (R6C5: CoT + fenced article +
  // footer), or a chain-of-thought prefix — fails the run rather than persist.
  const bulkFence = linked.match(/```[a-z]*\s*\n([\s\S]*?)\n\s*```/);
  if (
    linked.trimStart().startsWith("```") ||
    (bulkFence && bulkFence[1].length > linked.length * 0.5) ||
    COT_PREFIX_RE.test(linked.slice(0, 400))
  ) {
    throw new Error(
      "Article body is render-broken (fence or CoT prefix) after sanitizers — refusing to publish",
    );
  }
  // FINAL budget re-check (R5C7: passes running AFTER the mid-pipeline gates
  // re-inflated em-dashes 22→26 and re-introduced duplicate sentences). The
  // em-dash trigger here is CLUSTERING (lines with 2+ dashes) — the actual AI
  // tell — not raw count.
  let final = linked;
  {
    const dedupFinal = dropDuplicateSentences(
      final,
      deps.sentenceDedupMinChars,
    );
    if (dedupFinal.dropped > 0) {
      process.stdout.write(
        `        final check: dropped ${dedupFinal.dropped} duplicate sentence(s)\n`,
      );
      final = dedupFinal.text;
    }
    // Verify-and-retry like every other budget (R6C1: a single un-verified
    // decluster shot shipped 4 residual clusters).
    // Retriggered at 3+ dashes per sentence (R6C2 definitive ruling: 2-dash
    // bracketed parentheticals are correct English; the gate burned 2 calls/run
    // on false positives for 3 straight cycles).
    for (
      let clustered = emdashClusteredLines(final), pass = 1;
      clustered > 0 && pass <= 2;
      pass++
    ) {
      process.stdout.write(
        `        final check: ${clustered} run-on dash sentence(s) — declustering (${pass})...\n`,
      );
      const input = final;
      final = lengthSafe(
        "emdash-decluster",
        input,
        await withRetry("emdash-decluster", () =>
          llm.complete({
            prompt: `In this article, ${clustered} SENTENCES contain THREE OR MORE em-dashes (—) each — a run-on dash cadence. Rewrite ONLY those sentences so each keeps at most one or two em-dashes (a bracketed parenthetical "X — appositive — Y" is fine; convert the rest to commas, parentheses, or restructured sentences). Every other sentence stays exactly as written; preserve all links, numbers, and headings. Output ONLY the full corrected markdown article.\n\nARTICLE:\n${input}`,
            model: MODEL,
            temperature: 0.3,
          }),
        ),
      );
      clustered = emdashClusteredLines(final);
      if (clustered > 0 && pass === 2) {
        process.stdout.write(
          `        still ${clustered} run-on dash sentence(s) after 2 passes — accepting\n`,
        );
      }
    }
    // The decluster is the LAST LLM mutation and runs AFTER the sentence dedup
    // above — its rewrite can reintroduce duplicates with nothing downstream
    // re-checking (audit ordering hole). Code-only re-check.
    const postDecluster = dropDuplicateSentences(
      final,
      deps.sentenceDedupMinChars,
    );
    if (postDecluster.dropped > 0) {
      process.stdout.write(
        `        final check: dropped ${postDecluster.dropped} duplicate sentence(s) reintroduced by decluster\n`,
      );
      final = postDecluster.text;
    }
  }
  // Recoverable shape repair BEFORE the assertion: an in-body H1 is a
  // markdown-level mistake (the page template owns the H1 — the title), not a
  // body collapse. Demote to H2 instead of failing a 16-call run (R7C3: the
  // assertion refused a complete 2,758-word article over one model-written
  // "# " section header). Fence-aware; the assertion stays as the backstop.
  {
    const h1s = countHeadings(final, 1);
    if (h1s > 0) {
      let inFence = false;
      final = final
        .split("\n")
        .map((l) => {
          if (/^\s*```/.test(l)) inFence = !inFence;
          return !inFence && /^#[ \t]/.test(l) ? l.replace(/^#/, "##") : l;
        })
        .join("\n");
      process.stdout.write(
        `        demoted ${h1s} in-body H1 heading(s) to H2\n`,
      );
    }
  }
  // CoT-head recovery (R7C6: a fact-guard QA preamble persisted as the
  // body's first 35%): signatures in the first 10 lines + a later heading →
  // slice from the first heading. Deterministic, runs before the assertion.
  {
    const headLines = final.split("\n", 10);
    const firstHeading = final.search(/^#{1,6}\s/m);
    if (
      firstHeading > 0 &&
      headLines.some(
        (l) =>
          COT_PREFIX_RE.test(l) ||
          META_PROSE_RE.test(l) ||
          PREAMBLE_LINE_RE.test(l),
      )
    ) {
      process.stdout.write(
        `        pre-persist: sliced ${firstHeading} chars of CoT/meta head off the body\n`,
      );
      final = final.slice(firstHeading);
    }
  }
  // Hard pre-persist shape assertion (R6C3: a 343-word QA report published as
  // the body while every gate passed vacuously). ANY body-collapse from any
  // future pass becomes a loud failed run instead of a silent bad publish.
  if (
    final.split(/\s+/).length < 800 ||
    countHeadings(final, 2) < 3 ||
    META_PROSE_RE.test(final) ||
    PREAMBLE_LINE_RE.test(final.trimStart().split("\n")[0] ?? "") ||
    // ANY H1 means the title strip was defeated (R6C7: a preamble pushed the
    // draft H1 down and it rendered as a duplicate title). Deliberately
    // countHeadings(1) > 0, not text.ts's hasInBodyH1 — post-title-strip a
    // LEADING H1 is also a failure (stripPreambleAndFence can promote a
    // reintroduced H1 to position 0), and the lead-exempting form would let
    // that publish with a duplicate title.
    countHeadings(final, 1) > 0
  ) {
    throw new Error(
      `Final body is not article-shaped (${final.split(/\s+/).length} words, ${countHeadings(final, 2)} sections, metaProse=${META_PROSE_RE.test(final)}, inBodyH1=${countHeadings(final, 1) > 0}) — refusing to persist`,
    );
  }
  const linkedFinal = final;
  ctx.telemetry.article = {
    ...(ctx.telemetry.article ?? {}), // earlier passes may have set flags (e.g. titleFormulaCollision)
    headline: title,
    headlineChars: title.length,
    words: linkedFinal.split(/\s+/).length,
    entityLinks: linkCount,
    internalLinks: (linkedFinal.match(/\]\(\//g) ?? []).length,
    accordingTo: (linkedFinal.match(/according to/gi) ?? []).length,
    accordingToBeforeFix,
    // Count DETECTED before the fix passes ran — not how many were fixed
    // (round-8 item 3c rename; the value was always the detection count).
    repeatedShinglesDetected: repeated.length,
    tableRows: tableRowCount(linkedFinal),
    h2: countHeadings(linkedFinal, 2),
    boardDataCompanies: boardData.map((b) => b.company),
  };
  // First-party-data observability (R6C9+R6C10: two straight runs shipped
  // ZERO board facts in print while boardData sat in the draft prompt — the
  // omission was invisible). Heuristic substring check, warn-only.
  if (boardData.length > 0) {
    // Sentence-level co-occurrence (R7C7: "80 ASML roles added in the past 7
    // days" missed the exact-phrase check → false publish blocker).
    const bodySentences = splitSentences(linkedFinal);
    const boardDataUsedInPrint = boardData.some(
      (b) =>
        b.jobs.some((j) => j.title && linkedFinal.includes(j.title)) ||
        bodySentences.some(
          (sent) =>
            sent.includes(b.company) && sent.includes(String(b.addedInWindow)),
        ),
    );
    ctx.telemetry.article.boardDataUsedInPrint = boardDataUsedInPrint;
    if (!boardDataUsedInPrint) {
      process.stdout.write(
        `        ⚠ board data (${boardData.map((b) => b.company).join(", ")}) never cited in print\n`,
      );
    }
  }
  // Under-delivery observability (R6C9: 1,260 words vs the outline's
  // 2,500-4,000 target passed the 800-word catastrophe floor silently).
  // Warn-only — a length-enforcement loop buys filler, not substance.
  const draftWords = ctx.telemetry.article.words as number;
  if (draftWords < deps.draftWordWarnFloor) {
    ctx.telemetry.article.wordsBelowTarget = true;
    process.stdout.write(
      `        ⚠ draft is ${draftWords} words — below the ${deps.draftWordWarnFloor}-word warning floor (outline targets 2,500-4,000)\n`,
    );
  }
  const seo: SeoMeta = await runSeo(linkedFinal, gateDeps);

  const assembled = enr.withInternalLinks(
    {
      // The chosen NYT/WSJ headline, used verbatim as the post title (the SEO
      // pass still supplies the keyword-led seoTitle for search).
      title,
      content: linkedFinal,
      category: angle.category,
      description: seo.description,
      tags: seo.tags,
      keywords: seo.keywords,
      seoTitle: seo.seoTitle,
      seoDescription: seo.seoDescription,
    },
    // Filtered boardData only (R7C3: unfiltered companiesForBoard put
    // Ouihelp — a French home-care company — in an AI-token CTA). Empty →
    // the CTA's own /companies-hub fallback.
    boardData.map((b) => ({ name: b.company, url: b.url })),
  );
  // Final gate: every relative link must resolve to a real route — covers both
  // model-written body links and the appended CTA footer.
  const linkGate = await enr.enforceLinkIntegrity(assembled.content);
  if (ctx.telemetry.article)
    ctx.telemetry.article.linkIntegrity = linkGate.stats;
  // Final stage: the deterministic post-processing block's net effect (entity
  // links are already in linkedFinal; this pair captures the appended CTA +
  // enforceLinkIntegrity rewrites) and the exact published markdown.
  recordArtifact("final-article", linkedFinal, linkGate.content);
  // Soft fact-check audit (informational, NEVER a gate): rate every claim in
  // the published article against the research for manual review. The full
  // table is captured to the host's artifact store (stage "fact-check-audit") via
  // withRetry's input hook; here we just flag that it ran. Best-effort — a
  // failure must never block or fail the run.
  try {
    // First-party-first for the AUDIT: its input is sliced (auditInputChars),
    // and the pool's natural order (research → datagod → board) parks the
    // highest-authority material at the cut-off end. Reorder so board truth +
    // gov data are ALWAYS inside the audit window; fact-guard keeps the
    // unsliced pool, where order is irrelevant.
    await runFactCheckAudit(
      linkGate.content,
      `${boardTruth}${datagodBlock}${research}`,
      gateDeps,
    );
    ctx.telemetry.article = {
      ...(ctx.telemetry.article ?? {}),
      factCheckAudited: true,
    };
  } catch (err) {
    process.stdout.write(
      `        fact-check audit skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return { ...assembled, content: linkGate.content };
}
