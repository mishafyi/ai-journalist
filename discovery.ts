/**
 * Phase 1 — Discover & plan (section-research pipeline).
 *
 * Research-first replacement for the old "pick a topic from thin signal"
 * discoverTopics. Flow:
 *   1. Pull the DiscoverySignal from the injected Source (`gatherSignal`) — a
 *      domain-agnostic {items, framing?, corpus?}. A host adapter folds its own
 *      live signal into it; the engine never sees the host's native shape.
 *   2. generateQueries — one LLM call emits research queries + implicated companies.
 *   3. broadResearch — cheap, broad signal: web-search SNIPPETS (no scrape) per
 *      query + per-company RSS headlines, bounded by p-limit. (Deep grounding is
 *      Phase 2's job, per section.)
 *   4. pickStoryAndPlan — one LLM call picks the single best story and emits a
 *      structured section plan ({title, angle, sections:[{heading,intent,queries}]}).
 *   5. Anti-repetition — the chosen title clears the SAME stack discoverTopics
 *      used (trigram + entity/event + embedding cousin); on collision, re-pick
 *      once excluding the rejected title, else keep the least-similar.
 *
 * This module is engine-local and host-free: the pure trigram/entity
 * adjudicators are engine siblings; the LLM client, research / embedding /
 * retry / run-id helpers, and the run-event/error loggers (which couple to
 * clients, the LLM usage meter, and the host's run state) are all INJECTED
 * through the `DiscoveryDeps` object — this module imports nothing back from the
 * host orchestrator, so there is no import cycle. Every tunable knob (model +
 * thresholds + counts) is INJECTED too — the engine reads NO environment; the
 * host adapter binds its own config and passes the resolved values in.
 */
import pLimit from "p-limit";
import { trigramSimilarity, sharesEntityEvent } from "./primitives";
import { fetchRssHeadlines } from "./news";
import { DiscoveryOutput, Plan } from "./planning";
import { type DiscoverySignal, type LlmClient } from "./ports";

/**
 * A run-timeline event the orchestrator records (e.g. mapped to a host's run-log
 * table). Structural + host-free; the `event`/`status` literal unions are the
 * subset Phase 1 emits — assignable to a host's own enums at the wrapper boundary.
 */
export interface BlogRunEvent {
  runId: string;
  company: string;
  event: "fetch_start" | "fetch_complete" | "job_parsed";
  status: "info";
  message: string;
  /** Optional bulk payload lazy-loaded in the admin detail view (e.g. the
   *  pipeline's pooled section-research corpus, for claim auditing). */
  rawData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * The research / anti-repetition / LLM helpers Phase 1 needs, injected by the
 * host orchestrator so this module stays off the host's import graph. Each is the
 * host's own function/client — only the way this module reaches them differs.
 * `gatherResearch` is NOT here: Phase 1 uses snippets only (deep grounding is
 * Phase 2's job).
 *
 * `llm` SHOULD wrap the host's own completion client (NOT a separate one) so its
 * calls update the same usage meter `withRetry` reads — that coupling is what
 * makes the per-call telemetry / run-artifact capture work. `onEvent`/`onError`
 * are thin wrappers over the run loggers.
 *
 * `gatherSignal` is the Source's `gatherSignal()` — the ONLY way this module
 * gets its raw discovery material. It returns the domain-agnostic
 * `DiscoverySignal` ({items, framing?, corpus?}); a host adapter folds its own
 * signal into it. This module reads no host-native shape — it is fully generic.
 */
export interface DiscoveryDeps {
  llm: LlmClient;
  gatherSignal: () => Promise<DiscoverySignal>;
  searchSnippets: (query: string, limit: number) => Promise<string[]>;
  gatherCoveredTopics: () => Promise<string[]>;
  embedDedupSurvivors: (
    candidates: string[],
    covered: string[],
    simThreshold: number,
  ) => Promise<{
    survivors: string[];
    dropped: { cand: string; closest: string; sim: number }[];
  } | null>;
  withRetry: <T>(
    label: string,
    fn: () => Promise<T>,
    opts?: { input?: string; maxAttempts?: number },
  ) => Promise<T>;
  getRunId: () => string;
  onEvent: (event: BlogRunEvent) => Promise<void>;
  onError: (
    phase: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => void;
  /**
   * Tunable knobs, INJECTED (the engine reads no env). The adapter binds the
   * `BLOG_*` env vars to these (defaults in parens), so behavior is unchanged:
   *   model               — the LLM id for both discovery passes (BLOG_LLM_MODEL).
   *   dedupThreshold       — trigram near-dup cutoff (BLOG_DEDUP_THRESHOLD, 0.37).
   *   embedDedupSim        — embedding cousin cutoff (BLOG_EMBED_DEDUP_SIM, 0.86).
   *   discoveryQueries     — # research queries to emit (BLOG_DISCOVERY_QUERIES, 15).
   *   newsCompanies        — # implicated companies to chase (BLOG_NEWS_COMPANIES, 12).
   *   maxSections          — section cap on the plan (BLOG_MAX_SECTIONS, 7).
   *   sectionQueries       — query cap per section (BLOG_SECTION_QUERIES, 3).
   *   researchConcurrency  — p-limit for broad research (BLOG_RESEARCH_CONCURRENCY, 4).
   *   snippetsPerQuery     — snippets per query in broad research (BLOG_SNIPPETS_PER_QUERY, 5).
   *   rssPerCompany        — RSS headlines per company (BLOG_RSS_HEADLINES, 5).
   */
  model: string;
  dedupThreshold: number;
  embedDedupSim: number;
  discoveryQueries: number;
  newsCompanies: number;
  maxSections: number;
  sectionQueries: number;
  researchConcurrency: number;
  snippetsPerQuery: number;
  rssPerCompany: number;
}

/**
 * Format a domain-agnostic DiscoverySignal into the query-gen prompt body.
 *
 * The engine reads NO structured domain fields: each item contributes one
 * `- ${item.summary}` line (a host adapter folds its own specifics — e.g.
 * `name (industry): N new role(s) — titles — locations` — into `summary`), the
 * optional `framing` leads (aggregate stats + any section label the adapter
 * wants above the items), and the optional `corpus` trails (free-text the
 * query-gen pass reads beyond the per-item summaries). An empty item list
 * renders `(none)`.
 *
 * Byte-lock: `discovery.checks.ts` maps a representative fixture through a
 * replica of a host adapter's signal mapping and asserts the rendered prompt is
 * byte-identical, so a future change to this formatter can't drift it silently.
 * Exported for that check.
 */
export function buildSignalText(signal: DiscoverySignal): string {
  const items =
    signal.items.map((it) => `- ${it.summary}`).join("\n") || "(none)";
  return [
    signal.framing ? `${signal.framing}\n${items}` : items,
    signal.corpus ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Phase 1.2 — one LLM call: research queries + implicated companies. */
async function generateQueries(
  signal: string,
  deps: DiscoveryDeps,
): Promise<DiscoveryOutput> {
  const prompt = `You are the research desk for a frontier-tech hiring publication (space, defense, robotics, AI, energy, biotech). Below is our LIVE job-board hiring signal — who is hiring right now, for what, and where.

From it, output ONLY a JSON object (no prose, no code fences):
{
  "queries": [ ${deps.discoveryQueries} sharp web-search research queries, each able to open a SPECIFIC, timely story — funding rounds, expansions, hiring surges, talent moves, new programs, policy shifts ],
  "companies": [ the companies NAMED OR IMPLICATED in this signal whose recent news is worth checking — include partners, competitors, customers, acquirers, not only the hirers; up to ${deps.newsCompanies} ]
}

Spread the queries across the six aspects every strong story has — history (roots or break with the past), scope (how big/where/who), reasons (economic, political, psychological), impacts (who is helped or hurt), countermoves (what opponents or competitors are DOING, not saying), and futures (projections) — at least one query for each aspect that plausibly applies. Use search operators where they sharpen a query: quoted phrases for exact strings, - to exclude a dominant irrelevant sense, site: for a known primary source, intitle: for coverage checks.
When the signal itself is thin, generate story angles the five reporter's ways: EXTRAPOLATE (what common cause drives this development, and where else must that cause be producing the same effect?), SYNTHESIZE (what single thread unifies several seemingly unrelated postings/events?), LOCALIZE (turn a big abstract trend into one concrete, representative case from the board), PROJECT (skip the crowded central development — is this story juvenile or mature? if mature, target its impacts and countermoves instead), and SWITCH VIEWPOINT (tell it from a vantage nobody covering it occupies — the candidate's, the losing competitor's, the supplier's).

HIRING SIGNAL:
${signal}`;
  const out = await deps.withRetry(
    "discovery: query-gen",
    () =>
      deps.llm.completeStructured({
        messages: [{ role: "user", content: prompt }],
        schema: DiscoveryOutput,
        schemaName: "discovery_queries",
        model: deps.model,
        temperature: 0.6,
      }),
    { input: prompt },
  );
  return {
    queries: out.queries.slice(0, deps.discoveryQueries),
    companies: out.companies.slice(0, deps.newsCompanies),
  };
}

interface BroadResearch {
  pool: string;
  snippetCount: number;
  headlineCount: number;
}

/**
 * Phase 1.3 — broad, CHEAP signal: web-search snippets per query (no scrape) +
 * per-company RSS headlines, p-limit-bounded. Per-item failures are logged and
 * skipped (never abort the batch). Deep grounding is Phase 2 (per section).
 */
async function broadResearch(
  queries: string[],
  companies: string[],
  deps: DiscoveryDeps,
): Promise<BroadResearch> {
  const limit = pLimit(deps.researchConcurrency);
  const queryBlocks = await Promise.all(
    queries.map((q) =>
      limit(async () => {
        try {
          const snippets = await deps.searchSnippets(q, deps.snippetsPerQuery);
          return snippets.length
            ? {
                block: `### Search: "${q}"\n${snippets
                  .map((s) => `- ${s}`)
                  .join("\n")}`,
                n: snippets.length,
              }
            : null;
        } catch (err) {
          deps.onError("discovery.research", err, { query: q });
          return null;
        }
      }),
    ),
  );
  const companyBlocks = await Promise.all(
    companies.map((c) =>
      limit(async () => {
        try {
          const heads = await fetchRssHeadlines(
            `"${c}" news`,
            deps.rssPerCompany,
          );
          return heads.length
            ? {
                block: `- ${c}: ${heads.map((h) => h.title).join(" | ")}`,
                n: heads.length,
              }
            : null;
        } catch (err) {
          deps.onError("discovery.research", err, { company: c });
          return null;
        }
      }),
    ),
  );
  const qParts = queryBlocks.filter((b) => b !== null);
  const cParts = companyBlocks.filter((b) => b !== null);
  const pool = [
    qParts.length
      ? `## WEB SEARCH SIGNAL\n\n${qParts.map((p) => p.block).join("\n\n")}`
      : "",
    cParts.length
      ? `## RECENT COMPANY HEADLINES\n\n${cParts.map((p) => p.block).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    pool,
    snippetCount: qParts.reduce((a, p) => a + p.n, 0),
    headlineCount: cParts.reduce((a, p) => a + p.n, 0),
  };
}

/** Phase 1.4 — one LLM call: pick the single best story (or build the seeded
 *  one, for --topic) + emit a section plan with a domain category. */
async function pickStoryAndPlan(
  pool: string,
  avoid: string[],
  seed: string | null,
  deps: DiscoveryDeps,
): Promise<Plan> {
  const avoidBlock = avoid.length
    ? `\n\nDO NOT pick a story that overlaps any of these already-published or just-rejected stories — same subject AND angle counts as overlap even if worded differently; a company + a funding round that already appears here is a duplicate no matter how reframed:\n${avoid
        .map((t) => `- ${t}`)
        .join("\n")}`
    : "";
  const task = seed
    ? `Build a sectioned article around THIS story: "${seed}". Use the pooled research below to structure and ground it.`
    : "Pick the SINGLE best story — specific, timely, well-grounded in this research, and genuinely interesting to engineers and operators in space / defense / robotics / AI / energy / biotech — and design it as a sectioned article.";
  const prompt = `You are the editor of a frontier-tech hiring publication. Below is pooled research (web-search snippets + recent company news headlines). ${task}
Before choosing sections, think in cause-and-effect: the central development, the effects that logically follow, the reactions to those effects, and the constituencies touched — then FENCE the story: the sections must cover one coherent slice of that map, and the angle must make clear what is explicitly OUT of scope. Distrust remote links in the chain (they may not have happened yet); the plan's section queries must seek evidence, not confirmation.
Choose the APPROACH deliberately and let the story's nature (not habit) dictate it: a ROUNDUP (many sources, breadth) when the development is wide and no single case carries it; a MICROCOSM/PROFILE (one representative company or role carries the tale) ONLY when the exemplar is verifiably representative — vet it against the hiring data before building sections on it.
ORDER the sections as blocks of related material (never scatter one aspect across sections): after the theme is established, the FIRST detailed section must be the aspect your themeStatement stresses most (a newsy development → scope first; a well-known development → impacts or countermoves first); weave history in small touches where it adds contrast rather than as one lump.

Output ONLY a JSON object (no prose, no code fences):
{
  "title": "the article title",
  "angle": "one sentence stating the specific argument / throughline",
  "themeStatement": "<1-2 plain sentences of ACTION stating what the story SAYS — the development, one or two effects, the major reaction; no details, no numbers>",
  "category": "the story's primary domain — one of: robotics, artificial-intelligence, aerospace-engineering, defense, energy, biotech, frontier",
  "searchSeed": "a 2-4 word phrase a reader would type into Google to find this story (e.g. 'defense tech salaries', 'humanoid robot funding')",
  "sections": [
    { "heading": "section H2 heading", "intent": "one sentence: what this section establishes", "queries": ["targeted research query", "up to ${deps.sectionQueries} total"] }
  ]
}
Use at most ${deps.maxSections} sections. Each section's queries must be specific enough to return figures, quotes, and named sources when researched.${avoidBlock}

POOLED RESEARCH:
${pool}`;
  const plan = await deps.withRetry(
    "discovery: story-plan",
    () =>
      deps.llm.completeStructured({
        messages: [{ role: "user", content: prompt }],
        schema: Plan,
        schemaName: "story_plan",
        model: deps.model,
        temperature: 0.7,
      }),
    { input: prompt },
  );
  // Bound an over-producing editor.
  return {
    ...plan,
    sections: plan.sections.slice(0, deps.maxSections).map((s) => ({
      ...s,
      queries: s.queries.slice(0, deps.sectionQueries),
    })),
  };
}

/**
 * Lexical anti-repetition gate (PURE): a title duplicates covered work if it is
 * a trigram near-dup (≥ `dedupThreshold`) OR shares a company + money/round token
 * with a covered title (catches the low-trigram R6C4 class). The threshold is a
 * parameter (the engine reads no env; the adapter binds BLOG_DEDUP_THRESHOLD,
 * default 0.37). Exported for tests.
 */
export function titleCollidesLexically(
  title: string,
  covered: string[],
  dedupThreshold: number,
): boolean {
  return (
    covered.some((c) => trigramSimilarity(title, c) >= dedupThreshold) ||
    covered.some((c) => sharesEntityEvent(title, c))
  );
}

/**
 * Full anti-repetition gate: lexical (above) OR embedding meaning-cousin. The
 * embedding pass is best-effort — embedDedupSurvivors returns null when
 * EMBEDDING_URL is unset (laptop), and then the lexical verdict stands.
 */
async function titleCollides(
  title: string,
  covered: string[],
  deps: DiscoveryDeps,
): Promise<boolean> {
  if (titleCollidesLexically(title, covered, deps.dedupThreshold)) return true;
  const embed = await deps.embedDedupSurvivors(
    [title],
    covered,
    deps.embedDedupSim,
  );
  return embed !== null && embed.survivors.length === 0;
}

/** Phase 1 orchestrator — returns a vetted, anti-repetition-cleared section plan. */
export async function discoverStory(deps: DiscoveryDeps): Promise<Plan> {
  const runId = deps.getRunId();
  // The Source owns gathering the raw material (a host maps its own signal into
  // DiscoverySignal); the engine owns the logic. `buildSignalText` renders it
  // into the query-gen prompt body.
  const sig = await deps.gatherSignal();
  process.stdout.write(`  discovery signal: ${sig.items.length} items\n`);
  const signal = buildSignalText(sig);

  const disco = await generateQueries(signal, deps);
  process.stdout.write(
    `  discovery: ${disco.queries.length} queries, ${disco.companies.length} companies\n`,
  );
  await deps.onEvent({
    runId,
    company: "blog_generator",
    event: "fetch_start",
    status: "info",
    message: `Discovery: ${disco.queries.length} queries + ${disco.companies.length} companies from ${sig.items.length} signal items`,
    metadata: { queries: disco.queries, companies: disco.companies },
  });

  const research = await broadResearch(disco.queries, disco.companies, deps);
  process.stdout.write(
    `  broad research: ${research.snippetCount} snippets + ${research.headlineCount} company headlines (${research.pool.length} chars)\n`,
  );
  await deps.onEvent({
    runId,
    company: "blog_generator",
    event: "fetch_complete",
    status: "info",
    message: `Broad research: ${research.snippetCount} web snippets + ${research.headlineCount} company headlines pooled`,
    metadata: {
      snippetCount: research.snippetCount,
      headlineCount: research.headlineCount,
    },
  });
  if (!research.pool.trim()) {
    throw new Error("Broad research returned no signal — cannot pick a story");
  }

  const covered = await deps.gatherCoveredTopics();
  let plan = await pickStoryAndPlan(research.pool, covered, null, deps);
  let pickedLeastSimilar = false;
  if (covered.length && (await titleCollides(plan.title, covered, deps))) {
    process.stdout.write(
      `  anti-repetition: "${plan.title}" collides with covered work — re-picking once...\n`,
    );
    const rejected = plan.title;
    const plan2 = await pickStoryAndPlan(
      research.pool,
      [...covered, rejected],
      null,
      deps,
    );
    if (await titleCollides(plan2.title, covered, deps)) {
      // Both attempts collide — keep the least-similar title (lexical endgame).
      const simOf = (t: string): number =>
        covered.length
          ? Math.max(...covered.map((c) => trigramSimilarity(t, c)))
          : 0;
      plan = simOf(plan2.title) <= simOf(plan.title) ? plan2 : plan;
      pickedLeastSimilar = true;
      process.stdout.write(
        `  anti-repetition: both attempts collide — keeping least-similar title "${plan.title}"\n`,
      );
    } else {
      plan = plan2;
    }
  }

  await deps.onEvent({
    runId,
    company: "blog_generator",
    event: "job_parsed",
    status: "info",
    message: `Story: "${plan.title}" — ${plan.sections.length} sections${
      pickedLeastSimilar ? " [least-similar fallback]" : ""
    }`,
    metadata: {
      title: plan.title,
      angle: plan.angle,
      sections: plan.sections.map((s) => s.heading),
      pickedLeastSimilar,
    },
  });
  process.stdout.write(
    `  story: "${plan.title}" (${plan.sections.length} sections)\n`,
  );
  return plan;
}

/**
 * Build a section plan for an operator-specified topic (the --topic path):
 * research the topic broadly, then plan THAT story (seeded — no free re-pick,
 * no anti-repetition gate; the operator asked for this exact topic). Section
 * depth still comes from each section's own research in Phase 2.
 */
export async function planForTopic(
  topic: string,
  deps: DiscoveryDeps,
): Promise<Plan> {
  const research = await broadResearch([topic], [], deps);
  return pickStoryAndPlan(research.pool || topic, [], topic, deps);
}
