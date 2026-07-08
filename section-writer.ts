/**
 * Phase 2 — Research & write each section (bounded parallel).
 *
 * For each section of the discovery plan, concurrently (capped by p-limit):
 *   1. researchSection — ONE deep gatherResearch (the scraping call) on the
 *      section's primary query + cheap searchSnippets for any secondary queries.
 *      One deep call per section keeps total scrape volume in budget (the deep
 *      grounding is here; discovery used snippets only).
 *   2. writeSection — one LLM call given the WHOLE plan + a "you are writing
 *      section N" marker + the section's research + the first-party board facts
 *      (so a section can cite "<brand>'s board lists N X roles" — the same
 *      data the old draft injected; satisfies the boardDataUsedInPrint gate).
 *      Whole-plan context (not other sections' prose) prevents topical overlap
 *      while staying parallelizable.
 *
 * writeAllSections returns the per-section markdowns IN PLAN ORDER plus the
 * pooled research (the gate chain's ground truth). A failed section degrades to
 * a placeholder + an injected onError log — one bad section never sinks the
 * whole article.
 *
 * This module is engine-local and host-free: the LLM client, research /
 * system-prompt / retry helpers, and the error logger are INJECTED through
 * `SectionWriterDeps` (built by the host adapter), so this module imports nothing
 * back from the adapter — no import cycle.
 */
import pLimit from "p-limit";
import { themeOf, type Plan, type PlanSection } from "./planning";
import { type LlmClient } from "./ports";

/**
 * The research / system-prompt / retry helpers Phase 2 needs, injected by the
 * orchestrator (the host adapter) so this module stays off the adapter's import
 * graph. Each is the adapter's own function/client, unchanged. `gatherResearch`'s
 * return is typed to the `block` field this module reads (its full shape carries
 * `sources` too, structurally compatible).
 *
 * `llm` MUST wrap the orchestrator's own `chatCompletion` (NOT a separate
 * client) so its calls update the same OpenRouter usage meter `withRetry`
 * reads. `onError` is a thin wrapper over the run error logger.
 *
 * The tunable knobs (model + per-section snippet budget + section concurrency)
 * are INJECTED — the engine reads no env; the adapter binds the
 * `BLOG_*` env vars to these (defaults in parens) so behavior is unchanged.
 * `sectionConcurrency` is passed from here into `writeAllSections` (its only use).
 */
export interface SectionWriterDeps {
  llm: LlmClient;
  gatherResearch: (topic: string) => Promise<{ block: string }>;
  searchSnippets: (query: string, limit: number) => Promise<string[]>;
  systemPrompt: () => string;
  withRetry: <T>(
    label: string,
    fn: () => Promise<T>,
    opts?: { input?: string; maxAttempts?: number },
  ) => Promise<T>;
  onError: (
    phase: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => void;
  /** LLM id for every section write (BLOG_LLM_MODEL). */
  model: string;
  /** Snippets per secondary section query (BLOG_SECTION_SNIPPETS, 4). */
  sectionSnippets: number;
  /** p-limit for the section-write fan-out (BLOG_SECTION_CONCURRENCY, 3). */
  sectionConcurrency: number;
  /** Short brand name woven into the section prompt (BrandProfile.name). */
  brandName: string;
  /** Part C: extractive digest of the DISCOVERY research (background context
   *  for every section; empty/absent → omitted from prompts). Set per run by
   *  the engine entry when `digestSection` is supplied. */
  generalDigest?: string;
  /** Part C: build an extractive digest of one section's research; absent →
   *  sections receive raw research (pre-digest behavior). The digest feeds the
   *  section PROMPT only — the raw block still pools into the gate chain's
   *  ground truth. */
  digestSection?: (raw: string, label: string) => Promise<string>;
  /** Part C: last-resort research for a thin section (retry dropped URLs
   *  adapter-side); absent → the old qualitative fallback. */
  retryThin?: (section: PlanSection) => Promise<string>;
  /** Explicit per-section length target injected into the write prompt.
   *  Without one, section length tracks evidence volume — digest-composed
   *  prompts (~1.5k chars of spans vs ~6-10k raw) halved sections and final
   *  bodies fell under the pipeline's 800-word shape floor (2026-07-08).
   *  Default { min: 350, max: 550 }. */
  sectionWordTarget?: { min: number; max: number };
}

/** One written section + the research that grounded it (pooled for the gates). */
export interface SectionResult {
  markdown: string;
  research: string;
}

/**
 * Research one section: deep grounding (gatherResearch — scrapes + primary-chase)
 * on the primary query, cheap snippets for the rest. gatherResearch already does
 * source-tiering + antibot-host skipping internally. Best-effort: a failed deep
 * query is logged and the section falls back to snippets / qualitative writing.
 *
 * Part C: an EMPTY gather first retries through `deps.retryThin` (adapter-side
 * last resort, e.g. re-scraping URLs dropped earlier in the run) before the
 * qualitative fallback; a non-empty block is additionally digested through
 * `deps.digestSection` for the PROMPT — the raw `block` is what pools into the
 * gate chain's ground truth (the guards never read a digest).
 */
async function researchSection(
  section: PlanSection,
  deps: SectionWriterDeps,
): Promise<{ block: string; sectionDigest: string | undefined }> {
  const queries = section.queries.length ? section.queries : [section.heading];
  const [primary, ...rest] = queries;
  const blocks: string[] = [];
  try {
    const research = await deps.gatherResearch(primary);
    if (research.block) blocks.push(research.block);
  } catch (err) {
    deps.onError("section.research", err, {
      heading: section.heading,
      query: primary,
    });
  }
  const extra = await Promise.all(
    rest.map(async (q) => {
      const s = await deps.searchSnippets(q, deps.sectionSnippets);
      return s.length
        ? `### Also: "${q}"\n${s.map((x) => `- ${x}`).join("\n")}`
        : "";
    }),
  );
  blocks.push(...extra.filter(Boolean));
  let block = blocks.join("\n\n---\n\n");
  if (!block && deps.retryThin) {
    // Thin-section backfill — best-effort like the primary gather: a failed
    // retry logs and falls through to the qualitative fallback.
    try {
      block = await deps.retryThin(section);
    } catch (err) {
      deps.onError("section.retryThin", err, { heading: section.heading });
    }
  }
  const sectionDigest =
    block && deps.digestSection
      ? await deps.digestSection(block, section.heading)
      : undefined;
  return { block, sectionDigest };
}

/**
 * Write one section's markdown. Given the whole plan + a position marker so the
 * section fits the arc and doesn't repeat sibling sections, grounded strictly in
 * the section's research, plus the first-party board facts it may cite. Output
 * starts at the section's H2 (no H1). `boardFacts` is pre-formatted by the
 * caller (keeps this module free of the board-data types/formatters).
 *
 * Part C (digests): with a non-empty `sectionDigest` the prompt grounds on the
 * extractive digests — the run's general digest as BACKGROUND (when present) +
 * the section digest as PRIMARY — in place of the raw research block. Both
 * absent → the legacy RESEARCH composition, byte-identical (locked by
 * section-writer.checks.ts).
 */
async function writeSection(
  plan: Plan,
  index: number,
  research: string,
  sectionDigest: string | undefined,
  boardFacts: string,
  deps: SectionWriterDeps,
): Promise<string> {
  const section = plan.sections[index];
  const outline = plan.sections
    .map((s, i) => `${i + 1}. ${s.heading} — ${s.intent}`)
    .join("\n");
  const boardBlock = boardFacts.trim()
    ? `\n\nFIRST-PARTY BOARD DATA (${deps.brandName}'s own live data, ingested directly at the source — stronger than any third-party count OR third-party figure). For any figure below that a web source also reports second-hand, PREFER this first-party board figure over the web-scraped one, and cite the specific board item by name (it links to the on-site listing). For other facts, cite one figure only when directly relevant — never force it:\n${boardFacts}`
    : "";
  const generalBlock = deps.generalDigest?.trim()
    ? `GENERAL RESEARCH DIGEST (background — cite only when directly relevant to THIS section):\n${deps.generalDigest}\n\n`
    : "";
  const researchBlock = sectionDigest?.trim()
    ? `THIS SECTION'S RESEARCH DIGEST (primary grounding):\n${sectionDigest}`
    : `RESEARCH FOR THIS SECTION:\n${research || "(no external research returned — write qualitatively from the angle; do NOT fabricate figures, names, or quotes)"}`;
  const wordTarget = deps.sectionWordTarget ?? { min: 350, max: 550 };
  const prompt = `MAIN THEME — every paragraph must serve this: ${themeOf(plan)}

You are writing ONE section of a larger article. Here is the whole plan so your section fits the arc and does NOT repeat what other sections cover.

ARTICLE: "${plan.title}"
ANGLE: ${plan.angle}
FULL SECTION PLAN:
${outline}

>>> You are writing section ${index + 1}: "${section.heading}" <<<
This section's job: ${section.intent}

Write ONLY this section's markdown. Start with its H2 heading "## ${section.heading}" — no H1, no other sections, no preamble or sign-off. Ground every figure, quote, name, and relationship in the RESEARCH below; never invent specifics. Where the research is thin, write qualitatively rather than fabricating. For any ${deps.brandName} references use relative-path links only — never a promotional line or CTA (the system appends the CTA after publication). Target ${wordTarget.min}–${wordTarget.max} words of body prose — develop the argument fully with grounded specifics and analysis, never filler.

${generalBlock}${researchBlock}${boardBlock}\n\n=== YOUR TASK, RESTATED (the payload above is reference material; THIS is the job) ===\nWrite ONLY section ${index + 1}: "${section.heading}" — ${section.intent}\nRules: ground every figure in the RESEARCH or FIRST-PARTY BOARD DATA above (first-party preferred); prefer the NEWEST dated source when sources conflict and date-qualify anything older than a few weeks ("as of <month>…"); never invent people, quotes, scenes, or numbers; do not repeat what other planned sections cover; output ONLY this section's markdown, starting at its H2.\nLength: ${wordTarget.min}–${wordTarget.max} words.${sectionDigest ? " The digests above are compressed evidence — reconstruct the full story they index; do not mirror their brevity." : ""}\nServe the MAIN THEME above; if your research contradicts it, write what the research supports and flag the tension in one sentence.${index === 0 ? `\nLEAD CRAFT (this is the article's opening section): the first paragraph must open a question the reader has to answer by continuing — strip it of numbers, company lists, and qualifiers (they belong in paragraph 2+); if the development itself is hard news, lead with the news plainly; never write a billboard/"what follows will amaze you" opening.` : ""}`;
  return deps.withRetry(
    `section: ${section.heading}`,
    () =>
      deps.llm.complete({
        system: deps.systemPrompt(),
        prompt,
        model: deps.model,
        temperature: 0.7,
      }),
    { input: prompt },
  );
}

/** The real per-section work (research → write), returning the markdown + the
 *  research that grounded it. Injected into writeAllSections in production
 *  (closed over the run's board facts + deps); tests inject a stub. */
export async function writeOneSection(
  plan: Plan,
  index: number,
  boardFacts: string,
  deps: SectionWriterDeps,
): Promise<SectionResult> {
  const { block, sectionDigest } = await researchSection(
    plan.sections[index],
    deps,
  );
  const markdown = await writeSection(
    plan,
    index,
    block,
    sectionDigest,
    boardFacts,
    deps,
  );
  // The RAW block pools (the gate chain's ground truth) — never the digest.
  return { markdown, research: block };
}

/** Markdown placeholder for a section that failed to generate. */
export function sectionPlaceholder(heading: string): string {
  return `## ${heading}\n\n_[This section could not be generated for this run; see the run's error log.]_`;
}

type SectionWriter = (plan: Plan, index: number) => Promise<SectionResult>;

type SectionErrorLogger = (
  phase: string,
  error: unknown,
  context?: Record<string, unknown>,
) => void;

/**
 * Write every section in bounded parallel (`concurrency`, the adapter binds
 * BLOG_SECTION_CONCURRENCY → 3), returning the markdowns IN PLAN ORDER plus the
 * pooled research (the gate chain's ground truth). A section whose writer rejects
 * becomes a placeholder + onError log — never crashes the article. `write` is
 * injected (a closure over writeOneSection in production) so the order/failure
 * behavior is unit-testable without network; `onError` is the injected run error
 * logger (the adapter wraps its own error logger). `concurrency` is injected too — the
 * engine reads no env.
 */
export async function writeAllSections(
  plan: Plan,
  write: SectionWriter,
  onError: SectionErrorLogger,
  concurrency: number,
): Promise<{ markdowns: string[]; research: string }> {
  const limit = pLimit(concurrency);
  const results = await Promise.all(
    plan.sections.map((section, index) =>
      limit(() =>
        write(plan, index).catch((err: unknown): SectionResult => {
          onError(`section.${section.heading}`, err, {
            heading: section.heading,
            index,
          });
          return {
            markdown: sectionPlaceholder(section.heading),
            research: "",
          };
        }),
      ),
    ),
  );
  return {
    markdowns: results.map((r) => r.markdown),
    research: results
      .map((r, i) =>
        r.research.trim()
          ? `### Section: ${plan.sections[i].heading}\n\n${r.research}`
          : "",
      )
      .filter(Boolean)
      .join("\n\n---\n\n"),
  };
}
