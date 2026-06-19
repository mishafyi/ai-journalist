/**
 * blog-engine — the surgical gate / edit passes that run AFTER assembly, on the
 * finished article: the two editor reads (runEdit line-edit, runFinalEdit
 * managing-editor — also injected into assembly.ts's tieTogether), fact-guard,
 * the informational fact-check audit, the headline pass (with its full title-gate
 * suite), and SEO metadata derivation.
 *
 * Engine-pure: imports NOTHING from `@/`, prisma, or next — only sibling engine
 * modules (`./primitives`, `./ports`, `./run-context`). Every coupling these
 * passes had to `generate.ts`/`@/lib/openrouter` is injected through `GateDeps`:
 *   - `chatCompletion` → `deps.llm.complete` (the SAME wrapper-around-
 *     `@/lib/openrouter` generate.ts builds, so the shared usage meter + per-call
 *     BlogRunArtifact capture are preserved). The messages array the wrapper
 *     rebuilds is byte-identical to the old direct `chatCompletion([{role:"user",
 *     content:prompt}], {model, temperature})` call sites.
 *   - the `MODEL` constant → `deps.model`.
 *   - `withRetry` / the run telemetry carrier `ctx` → injected (`withRetry` stays
 *     a generate.ts primitive bound to that file's OpenRouter usage diff + ctx).
 *   - runTitle's extra couplings (the HEADLINES-backed exemplar sampler, the
 *     prisma prior-titles read, `embedDedupSurvivors`, its numeric knobs) →
 *     injected so the engine never reaches the headline corpus, the DB, or the
 *     embedding service directly.
 *
 * The function bodies are otherwise UNCHANGED — same prompts (byte-for-byte —
 * locked by gates.checks.ts), same thresholds, same order, same stdout. The
 * publication-name literal the brand-lift targets appears in NONE of these
 * prompts (the lift is a no-op here — gates.checks.ts asserts its absence), so
 * no BrandProfile substitution was needed.
 */
import { z } from "zod";
import { type LlmClient } from "./ports";
import { type RunContext } from "./run-context";
import { trigramSimilarity } from "./primitives";

/**
 * The minimal angle shape runTitle reads (generate.ts's richer `Angle` —
 * category/angle/hook/searchSeed/researchQueries — is structurally assignable).
 * Kept local so the engine doesn't depend on the orchestrator's interface.
 */
export interface TitleAngle {
  category: string;
  angle: string;
  searchSeed: string;
}

/**
 * SEO metadata, derived by runSeo. The model returns this as Zod-validated JSON
 * (OpenRouter `json_schema` response format) — no `{…}`-slice parse. Exported as
 * the schema (for the structured call) and the inferred type. Kept
 * constraint-free: strict structured-output mode rejects min/max/length
 * keywords; the char caps are applied to the returned values in runSeo.
 */
export const SeoMetaSchema = z.object({
  title: z.string(),
  description: z.string(),
  seoTitle: z.string(),
  seoDescription: z.string(),
  tags: z.array(z.string()),
  keywords: z.array(z.string()),
});
export type SeoMeta = z.infer<typeof SeoMetaSchema>;

/**
 * The couplings the gate passes need, injected by the orchestrator (generate.ts)
 * so this module imports nothing back from it or from `@/`. `llm`/`model`/
 * `withRetry`/`ctx` serve every pass; the rest are runTitle-only.
 */
export interface GateDeps {
  /** The shared OpenRouter-backed client (wraps generate.ts's own chatCompletion). */
  llm: LlmClient;
  /** The BLOG_LLM_MODEL value (generate.ts's `MODEL`). */
  model: string;
  /** generate.ts's retry+telemetry wrapper — exact signature, bound to its ctx. */
  withRetry: <T>(
    label: string,
    fn: () => Promise<T>,
    opts?: { input?: string; maxAttempts?: number },
  ) => Promise<T>;
  /** The per-run telemetry/artifact carrier (title-gate flags are written here). */
  ctx: RunContext;
  /** Headline-corpus exemplars for a category (generate.ts folds corpusDomain +
   *  sampleExemplars over its HEADLINES module data). runTitle-only. */
  gatherExemplars: (category: string, count: number) => string[];
  /** Recent published titles (the prisma prior-titles read). runTitle-only. */
  fetchPriorTitles: () => Promise<string[]>;
  /** Embedding near-paraphrase dedup. Returns null when EMBEDDING_URL is unset.
   *  runTitle-only. */
  embedDedupSurvivors: (
    candidates: string[],
    covered: string[],
    simThreshold: number,
  ) => Promise<{
    survivors: string[];
    dropped: { cand: string; closest: string; sim: number }[];
  } | null>;
  /** BLOG_TITLE_EXEMPLARS. runTitle-only. */
  titleExemplarCount: number;
  /** BLOG_TITLE_COLLISION_SIM. runTitle-only. */
  titleCollisionSim: number;
  /** BLOG_TITLE_EMBED_SIM. runTitle-only. */
  titleEmbedSim: number;
  /** BLOG_SEARCH_TERMS. runTitle-only. */
  searchTermsCount: number;
}

/** Strip a whole-body code fence (```lang\n…\n```) that wraps the ENTIRE text. */
function unfence(text: string): string {
  const m = text.match(/^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/);
  return m ? m[1] : text;
}

/** Pass 6 — line-edit the draft (the journalist self-edit pass). */
export async function runEdit(draft: string, deps: GateDeps): Promise<string> {
  const prompt = `Line-edit this draft for publication. Apply the newspaper self-edit pass: kill passive voice and nominalizations, fix adjective pile-up and editorializing, cut throat-clearing and clichés, break fact-lists into narrative, cut repeated material (each statistic, sentence, and company list appears ONCE, at its strongest spot — rephrase later references instead of restating the number), thin stat pile-ups (where a paragraph strings three or more figures, keep the anchor number and fold the rest into one summarizing clause — or, when the figures are comparable salaries or market forecasts, into a small markdown table), ensure "said" attribution with at most two "according to" in the whole piece, vary sentence length, vary section-header shapes (never let every H2 share one construction — e.g. the "Topic — Subtitle" em-dash pattern on every header; mix plain noun phrases, claims, and the occasional question), and cut about 10%. Keep every markdown link and the H1 intact. Output ONLY the edited markdown article, nothing else.

DRAFT:
${draft}`;
  return deps.withRetry(
    "edit",
    () =>
      deps.llm.complete({
        prompt,
        model: deps.model,
        temperature: 0.5,
      }),
    { input: prompt },
  );
}

/**
 * Pass 7 — managing-editor final read. Not line-editing (that was Pass 6): a
 * whole-piece pass for impact + integrity — does the lede land, does the kicker
 * land, does the spine hold, are AI tells/hype gone, is everything grounded.
 */
export async function runFinalEdit(
  article: string,
  deps: GateDeps,
): Promise<string> {
  const prompt = `You are the managing editor giving this piece its final read before print. You are NOT line-editing — read the whole thing for impact and integrity, and change only what's needed:
- Lede: does the first sentence earn attention? If it's throat-clearing or generic, rewrite it to open on a hard verified fact, a real named company's move, or a provocation — never an invented person, scene, or event (an undocumented demo, incident, or moment narrated with specific details is fabrication, even with no one named).
- Kicker (last paragraph): does it land on a concrete image or implication? Kill any "In conclusion", summary, or empty optimism. A kicker may CALL BACK to an earlier idea but must rephrase it — copying a sentence from an earlier section verbatim (or near-verbatim) is a repetition failure, not a callback.
- Spine: each section should earn the next. Cut or reorder any paragraph that stalls the through-line or could be shuffled without loss.
- Repetition: the same statistic, sentence, company list, or distinctive phrase must not appear twice in the piece — near-verbatim rewording counts as repetition ("pulling mid-career talent away from legacy defense primes" twice with two words swapped is still a repeat). Keep the strongest instance and cut or genuinely rework the other.
- Structural duplication: if two or more sections each enumerate the same set of named entities doing the same kind of thing (e.g. three sections that each list companies funding training programs), MERGE them into one section — that is shuffle-without-loss duplication even when the sentences differ. The same applies to FACT-CLUSTERS: when the same 2-3 distinctive figures travel together into two sections ("250 days + 8–15 months" appearing in both the backlog section and the bottleneck section), they belong in ONE place — rewording or swapping an acronym for the full name does not make it new material.
- Kill any AI tells, hedging, or hype that survived the line edit; enforce "said" attribution and at most two "according to" in the whole piece.
- INTEGRITY (most important): cut or fix any invented individual — a person whose story isn't in the reporting, including UNNAMED composites ("a former Google engineer who left to join…", "a 26-year-old researcher at…", an invented "she/he" you narrate). Replace any fictional protagonist with the real trend, named companies, and verified numbers. Every person, number, and quote must trace to the research.
Make surgical changes, not a rewrite — preserve the reporting and the voice. Keep every markdown link and heading intact. Output ONLY the finished markdown article, nothing else.

ARTICLE:
${article}`;
  return deps.withRetry(
    "final-edit",
    () =>
      deps.llm.complete({
        prompt,
        model: deps.model,
        temperature: 0.45,
      }),
    { input: prompt },
  );
}

/**
 * Pass 8.5 — fact-guard. owl-alpha invents vivid specifics for ledes/scenes
 * despite the grounding rules — named people ("Maya Chen"), unnamed composites
 * ("a senior RF engineer who…"), AND undocumented EVENTS/SCENES (a demo-day
 * anecdote with invented measurements). This dedicated pass diffs the article
 * against the research and strips any person OR scene that isn't actually
 * reported — the enforcement layer the in-prompt rules can't guarantee alone.
 */
export async function runFactGuard(
  article: string,
  research: string,
  deps: GateDeps,
): Promise<string> {
  const prompt = `You are a fact-checker. The ARTICLE must be grounded entirely in the RESEARCH DATA below. Find every FABRICATION the article presents as real but that is NOT in the research: (a) any INDIVIDUAL PERSON — named ("Maya Chen said…") or an unnamed composite ("a senior RF engineer who left FAANG…", "a 26-year-old researcher at…") — whose story isn't reported; AND (b) any SPECIFIC SCENE OR EVENT narrated with concrete details — a demo, incident, meeting, or moment with specific actions, measurements, timing, or dialogue ("At a robotics demo day, a humanoid robot tightened four bolts in thirty seconds; weeks later on the factory floor it failed, the bolts half a centimeter off") — that isn't documented in the research. Both are fabrications and must go, even when no person is named.

Rewrite the article to remove every fabrication:
- If it OPENS on an invented person, scene, or event, replace that opening with a grounded hook — a verified number, a real named company's move, or the documented trend — that still earns attention. The single most common failure is a vivid invented opening anecdote with no source; treat any undocumented opening scene as fabrication.
- Elsewhere, replace fabricated individuals and invented scenes/events with the real companies, numbers, and trend the research supports.
- SET-MEMBERSHIP integrity: when the article enumerates entities as members of a named set ("used by Google, ByteDance, and Tencent", "companies like X and Y are hiring for these roles", "adopters include..."), EVERY listed entity must appear in that set IN THE RESEARCH. Strip any member the research doesn't place there — prepending a marquee name to a real list, or presenting on-site companies as examples of a hiring trend the research never ties them to, is fabrication.
- RELATIONSHIP integrity: when the article asserts a specific relationship between named entities — X recruits or poaches talent from Y, X supplies or partners with Y, X competes with Y for Z, X is located in or moving to Z — the research must support THAT relationship, not merely mention both names. An entity that appears in the research in a DIFFERENT role (as an analogy, comparison, or strategy reference — "a playbook Apple pioneered") does NOT license naming it as a talent source, supplier, partner, or competitor; and an entity absent from the research entirely can carry no relationship at all. Strip the claim or soften it to what the research actually reports.
- QUOTED-SPAN integrity: every span inside quotation marks must appear VERBATIM in the research. If a source paraphrases or hedges ("X suggests it may have been …"), those words may NOT be quoted — either quote the source's actual quoted words or remove the quotation marks and attribute the paraphrase ("according to X's account"). A paraphrase wearing quotation marks is fabrication.
- TABLE-CELL attribution: for any figure inside a markdown table, the cited source must contain THAT figure for THAT role/level. If the source gives a different number or a different role, fix the cell or relabel the source — a synthesized number wearing a real source's name is fabrication.
- Verify ATTRIBUTION: where the article credits a figure to a source ("the IFR said", "McKinsey projects"), the research must credit that SAME source; if it credits a different one, fix the attribution. Attribute to the PRIMARY source: when the research shows a figure originated with a named study, agency, or major outlet and was merely re-cited by an aggregator/SEO blog, credit the originator — "Marketing Code's analysis found" for a BloombergNEF number launders authority and is an attribution failure. If the research gives NO identifiable source for a figure, CUT the figure or soften it to a magnitude ("hundreds of thousands of openings") — NEVER strip the credit and leave the precise number standing naked. Big claims (market sizes, "X% of companies", record investments, salary medians) MUST carry their source inline; an extraordinary number with no source reads as invented even when it isn't. This INCLUDES synthesized statistics: a quantitative claim the article presents as reported ("companies are offering 20–40% premiums in job postings") that appears in NO research source is a fabrication even if directionally plausible — soften it to an explicitly-derived observation ("the gap between X's $A and Y's $B suggests…") or cut it; NEVER let an unsourced number be the headline-bearing claim. And it includes LOOKS-SOURCED claims: when the article attributes a figure or projection to a named authority ("the American Welding Society has projected a shortage of 400,000 by 2027"), that authority AND that number must appear in the research — a confident citation you cannot find in the research is the model's memory wearing a source's name, and memory is frequently wrong; soften to a magnitude without the false credit, or cut.
- Keep everything already grounded: real named people/companies/events/numbers that ARE in the research stay. Keep every markdown link and heading. Preserve the voice and structure; change only what's fabricated or unsupported.
- Attribution: COUNT every "according to" in the article. If it appears more than TWICE, rewrite the excess into varied forms — "X reported", "per X", "X's data shows", "X found", or state the fact and cite the source once nearby. Leaving more than two "according to" is a failure.
- AI-tell words: remove every occurrence of these, rephrasing naturally — "delve", "landscape" (as in "the X landscape"), "leverage" (as a verb → "use"), "tapestry", "pivotal", "cornerstone", "robust", "navigate" (abstract), "realm", "underscore(s)", "comprehensive", "cutting-edge", "spearhead", "harness".

Output ONLY the corrected markdown article, nothing else.

RESEARCH DATA (the only facts that are real):
${research}

ARTICLE:
${article}`;
  return deps.withRetry(
    "fact-guard",
    () =>
      deps.llm.complete({
        prompt,
        model: deps.model,
        temperature: 0.3,
      }),
    { input: prompt },
  );
}

/**
 * Soft fact-check audit (INFORMATIONAL — never a publish gate). One LLM call
 * rates every factual claim in the FINISHED article against the raw research:
 * FOUND (in the research), DERIVABLE (follows by reasoning/arithmetic — e.g. a
 * total that is the sum of sourced awards), or NOT FOUND. Recorded to
 * BlogRunArtifact (stage "fact-check-audit") + a telemetry flag for human
 * review after publish. Replaced the deterministic figure-grounding gate,
 * which could not tell a derived total ($627M = three sourced awards) from a
 * fabrication and so false-blocked publishes. Best-effort; never blocks.
 */
export async function runFactCheckAudit(
  article: string,
  groundTruth: string,
  deps: GateDeps,
): Promise<string> {
  const prompt = `You are a fact-checker reviewing a PUBLISHED article against its RESEARCH. For every factual claim — especially every NUMBER, figure, date, named entity, and quoted span — rate whether the research supports it:
- FOUND: the claim (in substance) appears in the research.
- DERIVABLE: not stated verbatim, but it follows from the research by simple reasoning or arithmetic — e.g. a total that is the sum of sourced components. SHOW the derivation.
- NOT FOUND: the research contains nothing that supports it.
Output ONLY a markdown table: | Claim | Rating | Evidence / derivation / note |. One row per checked claim; lead with the load-bearing numbers. Be concise. This is an informational audit for a human reviewer — do NOT rewrite or comment on the article.

RESEARCH:
${groundTruth.slice(0, 120000)}

ARTICLE:
${article}`;
  return deps.withRetry(
    "fact-check-audit",
    () =>
      deps.llm.complete({
        prompt,
        model: deps.model,
        temperature: 0.2,
      }),
    { input: prompt },
  );
}

/**
 * Google autocomplete for a seed phrase — the real queries people type, used as a
 * search signal for the Title pass. Tries the full seed, then progressively
 * shorter prefixes (a niche compound like "defense tech AI engineer salary"
 * autocompletes to nothing → fall back to "defense tech AI" → "defense tech").
 * Best-effort (empty on any failure).
 */
async function gatherSearchTerms(
  seed: string,
  searchTermsCount: number,
): Promise<string[]> {
  const fetchAutocomplete = async (q: string): Promise<string[]> => {
    try {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(
        q,
      )}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const data = (await res.json()) as [string, string[]];
      return Array.isArray(data?.[1]) ? data[1] : [];
    } catch {
      return [];
    }
  };
  const words = seed.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  for (let n = words.length; n >= Math.min(2, words.length); n--) {
    const terms = await fetchAutocomplete(words.slice(0, n).join(" "));
    if (terms.length) return terms.slice(0, searchTermsCount);
  }
  return [];
}

/**
 * Result shape for the headline pass. The model returns this as validated JSON
 * (OpenRouter `json_schema` response format), so candidates arrive as clean
 * strings — never a free-text "1. <candidate>" list a model could wrap in
 * literal `<candidate>…</candidate>` tags. Kept constraint-free: strict
 * structured-output mode rejects min/max/length keywords; length and content
 * bounds are enforced on the returned values in runTitle below.
 */
const TitleResultSchema = z.object({
  candidates: z.array(z.string()),
  best: z.string(),
});

/**
 * Pass 8 — headline. Reads the WHOLE finished article, finds its strongest
 * headline material, and writes candidates across several angles (the stat, the
 * tension, the human moment, the searchable phrasing) — anchored to real-headline
 * corpus exemplars for STYLE and to live Google-autocomplete queries for the
 * language people actually search. Self-judges, picks the sharpest, uses it
 * verbatim as the post title, and strips the draft's in-content H1 (the template
 * renders title as the page H1). Returns the article (H1 stripped) + the title.
 */
export async function runTitle(
  article: string,
  topic: string,
  angle: TitleAngle,
  groundTruth: string,
  deps: GateDeps,
): Promise<{ content: string; title: string }> {
  const ctx = deps.ctx;
  const exemplars = deps.gatherExemplars(
    angle.category,
    deps.titleExemplarCount,
  );
  const searchTerms = await gatherSearchTerms(
    angle.searchSeed,
    deps.searchTermsCount,
  );
  process.stdout.write(
    `        search seed "${angle.searchSeed}" -> ${searchTerms.length} autocomplete terms\n`,
  );
  // Prior-title memory (R6C10: "didn't exist 18 months ago … paying $241,000"
  // shipped as a near-verbatim template rerun of a published headline — the
  // title pass never saw prior titles; only discovery did). Actual TITLES, not
  // gatherCoveredTopics' keyword-or-title mix. Best-effort: no memory beats a
  // dead title pass.
  const priorTitles = await deps.fetchPriorTitles();
  // Body without any whole-body code fence (which would defeat every regex
  // below AND the entity-linker), the draft's leading H1, + any rule after it —
  // for the prompt (so the model isn't anchored to the draft's own title) and
  // as the published content (the post template owns the page H1).
  const body = unfence(article)
    .replace(/^\s*#\s.*(?:\r?\n)+/, "")
    .replace(/^\s*(?:[-*_]\s*){3,}(?:\r?\n)+/, "");
  const styleBlock = exemplars.length
    ? `STYLE — these real headlines from top publications set the CRAFT floor (specific, concrete, active-verb, a number or named entity). Match their craft, then EXCEED their pull:\n${exemplars
        .map((t) => `- ${t}`)
        .join("\n")}\n\n`
    : "";
  const searchBlock = searchTerms.length
    ? `WHAT PEOPLE SEARCH (live Google autocomplete for this topic — use this language where it sharpens the headline, never force it):\n${searchTerms
        .map((t) => `- ${t}`)
        .join("\n")}\n\n`
    : "";
  const prompt = `You are the headline editor at a major newspaper. Your goal: a headline the reader CANNOT scroll past — maximum stop-power built entirely from REAL reported material. Curiosity, hard data, and shock value working together; never boilerplate clickbait.

${styleBlock}${searchBlock}${
    priorTitles.length
      ? `ALREADY PUBLISHED on this site — these headlines' structural formulas are USED UP. Do not reuse their templates ("didn't exist N months ago … pays $X"), their hooks, or near-identical phrasings:\n${priorTitles
          .slice(0, 40)
          .map((t) => `- ${t}`)
          .join("\n")}\n\n`
      : ""
  }NORTH STAR — the working title + angle this article was written to. Honor THIS story and its framing. But the working title is the long, descriptive label used to STEER the draft — it is NOT the final headline: write a tighter, sharper front-page version of the SAME story; never copy the working title or merely trim it.
- Working title: ${topic}
- Angle: ${angle.angle}

GROUND IT: headline only what the article establishes through real reporting — verified numbers, named real companies/events, the documented trend. If the article OPENS with an illustrative scene about an unnamed individual, that person's specific details (an exact offer, their age, their school) are a storytelling device, NOT reported fact — never put them in the headline as if they were real. Do NOT assert a causal or trade-off link between two facts unless the article reports that link: if the piece says a company both cut staff AND funded training, the headline may state both, but "cuts X to fund Y" or "swaps X for Y" requires the article to actually report the swap. ABSOLUTES ("None", "Zero", "Every", "All", "No one") are claims too — use one ONLY if the article reports that absolute; otherwise soften ("almost none", "rarely surface") or drop it.

Find the article's most ARRESTING grounded material, then write 8 candidate headlines attacking from DIFFERENT angles (NOT 8 variations of one):
- 2 front-loading the most shocking VERIFIED number or fact in the article
- 2 with a CURIOSITY GAP: a concrete claim with ONE crucial element withheld — the who, the how, or the consequence — that the article's opening closes fast ("The best-paid engineers in defense tech never touch a weapon.")
- 2 built on a PARADOX: two true facts from the article that shouldn't both be true ("Robots run the night shift. The owners can't hire humans fast enough.")
- 2 on READER STAKES: what this means for the reader's pay, career, or city — second person allowed
Write to the tight newspaper standard: a NYT/WSJ front-page headline runs about 8-10 words (~60-80 characters). Treat that as the target you write toward — not a hard limit; an exceptional headline that runs a little over is fine, and headlines should vary in shape, so never pack a second idea into the title just to fill space. PREFER ONE sharp sentence. A two-sentence "setup-punch" (WSJ-style: "They Crashed the Economy in 2008. Now They're Back and Bigger Than Ever.") is a tool for GENUINE TENSION only — both sentences short, never three, never an explanatory clause tacked on. The supporting context — the second number, the nut graf, the "why it matters" — belongs in the DECK (the article summary), not the headline: write the headline as the punch and let the deck carry the setup. (The publish schema still hard-cuts at 200 characters; never exceed that.) All specific to THIS article.

BANNED (instant boilerplate): "You won't believe", "shocking"/"stunning" as words, "the ultimate", "N ways to", "How to", question-bait the article can't answer, ALL-CAPS words, exclamation marks, colon-listicles.

Then judge all 8 like a front-page editor and pick the single strongest: the one that SELLS hardest — the gap the reader MUST close, the hook rock solid. The hook must land within the FIRST EIGHT WORDS — an opening sentence that is a flat statistic is a lede, not a headline. A two-sentence candidate earns its length only when BOTH sentences carry their own verified hook; otherwise prefer the sharper single-sentence punch. NEVER undersell the story: if the article holds a $500k salary, a 10x surge, a first-ever, or a collision of giants, the headline leads with the biggest weapon it has.

ARTICLE:
${body}

Write 8 candidate headlines, then judge them and choose the single strongest.
Return the eight as "candidates" and the chosen one as "best" — "best" MUST be
one of your candidates, copied verbatim.`;
  // Structured output: the model returns a Zod-validated { candidates, best }
  // object, grammar-constrained by OpenRouter's json_schema response format.
  // Headlines therefore arrive as clean strings — they can never be wrapped in
  // markdown fences or stray placeholder tags the way a free-text
  // "1. <candidate>" template invited (which shipped literal
  // <candidate>…</candidate> into live titles, 2026-06-16).
  const result = await deps.withRetry(
    "title",
    () =>
      deps.llm.completeStructured({
        messages: [{ role: "user", content: prompt }],
        schema: TitleResultSchema,
        schemaName: "headline_candidates",
        model: deps.model,
        temperature: 0.8,
      }),
    { input: prompt },
  );
  // Tidy a headline string: drop any surrounding quote/heading punctuation and
  // collapse whitespace. A no-op on the structured candidates (which arrive
  // clean), but still guards the free-text compress fallback further below.
  const clean = (s: string): string =>
    s
      .replace(/^["'#\s]+|["'\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const allCands = result.candidates.map(clean).filter(Boolean);
  // No artificial length limits (operator decision 2026-06-11): the only bound
  // is the publish schema's 200-char truncation below. Candidate lengths
  // logged for observability.
  let title =
    clean(result.best) ||
    allCands[0] ||
    article.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    topic;
  process.stdout.write(
    `        title candidates: ${allCands.map((c) => c.length).join(",")} chars; picked ${title.length}\n`,
  );
  // Gate adjudication trail (round-8 #7: three straight reviews could not
  // adjudicate the title gates — candidates were logged as LENGTHS only and
  // a re-pick never said which candidate replaced which). Every gate records
  // an event; `from === to` means the gate FLAGGED but kept the title (no
  // clean candidate). Persisted verbatim with the candidates into
  // ctx.telemetry.article.titleGateTrace at the end of this pass; stdout stays
  // as-is.
  const titleGateEvents: { gate: string; from: string; to: string }[] = [];
  const gateEvent = (gate: string, from: string, to: string): void => {
    titleGateEvents.push({ gate, from, to });
  };
  // Formula-collision gate (R6C10: a near-verbatim template rerun of a
  // published headline shipped — the prompt block above asks; this enforces).
  // Collision = high trigram overlap with any prior title, or a frame that
  // has already run multiple times ("didn't exist … ago" is on its 3rd use).
  {
    const RERUN_FRAMES = [
      /didn'?t exist .{0,40}\bago\b/i,
      // The "jobs nobody knows about" close is on its ~4th title (R7C1) —
      // the site's most-worn formula, invisible to trigram similarity.
      /(almost no one|no ?one|nobody|most [\w-]+ don'?t)[^.]{0,40}(know|notice|unnoticed)/i,
      // 4th use + company-and-number near-rerun shipped (R7C9: "Anduril
      // posted 221 jobs in a single week" vs the published "…220 jobs").
      /\b(posted|added)\s+[\d,]+\s+(?:open\s+)?(?:jobs|roles)\s+in\s+a(?:\s+single)?\s+week\b/i,
      // 2nd consecutive "$1 million" coda; ~5th up-to-$N coda in 8 cycles.
      /[—-]\s*and\s+(?:they\s+)?(?:pays?|earns?)\s+up\s+to\s+\$\d/i,
    ];
    const collides = (cand: string): boolean =>
      priorTitles.some(
        (p) => trigramSimilarity(cand, p) >= deps.titleCollisionSim,
      ) || RERUN_FRAMES.some((re) => re.test(cand));
    if (collides(title)) {
      const alt = allCands
        .filter(
          (c) =>
            c.length >= 20 && c.length <= 200 && c !== title && !collides(c),
        )
        .sort((a, b) => b.length - a.length);
      if (alt.length > 0) {
        process.stdout.write(
          `        title collides with a published formula — re-picked non-colliding candidate\n`,
        );
        // Recorded via gateEvent (round-8 #7) — the old single-event
        // titleGateTrace object this gate wrote alone is superseded by the
        // pass-wide trace persisted at the end of runTitle.
        gateEvent("collision", title, alt[0]);
        title = alt[0];
      } else {
        process.stdout.write(
          `        title collides with a published formula, no clean candidate — keeping (recorded)\n`,
        );
        gateEvent("collision", title, title);
        ctx.telemetry.article = {
          ...(ctx.telemetry.article ?? {}),
          titleFormulaCollision: true,
        };
      }
    }
  }
  // Embedding near-paraphrase gate (round-8 #8): meaning-cousins of published
  // headlines clear both the trigram collision gate and the frame list when
  // the WORDING diverges (R7C7's same-day xAI sibling). Cosine ≥
  // TITLE_EMBED_SIM against any prior title trips it; titles legitimately
  // share topic vocabulary, so the threshold is tighter than the topic
  // gate's. On a trip, re-pick via the standard candidate scaffolding
  // (filtered to candidates that themselves clear the embedding gate); with
  // no clean candidate, keep + record — observe-only for now, NOT a publish
  // blocker. Laptop runs skip (EMBEDDING_URL unset → helper returns null).
  if (priorTitles.length) {
    const probe = await deps.embedDedupSurvivors(
      [title],
      priorTitles,
      deps.titleEmbedSim,
    );
    if (probe !== null && probe.dropped.length > 0) {
      const { closest, sim } = probe.dropped[0];
      process.stdout.write(
        `        title is an embedding near-paraphrase (sim ${sim.toFixed(2)}) of published "${closest.slice(0, 80)}"\n`,
      );
      const altPool = allCands
        .filter((c) => c.length >= 20 && c.length <= 200 && c !== title)
        .sort((a, b) => b.length - a.length);
      const rePick = altPool.length
        ? await deps.embedDedupSurvivors(
            altPool,
            priorTitles,
            deps.titleEmbedSim,
          )
        : null;
      if (rePick !== null && rePick.survivors.length > 0) {
        process.stdout.write(
          `        — re-picked a candidate clear of prior titles\n`,
        );
        gateEvent("embed-similar", title, rePick.survivors[0]);
        title = rePick.survivors[0];
      } else {
        process.stdout.write(
          `        — no clean candidate; keeping (recorded, observe-only)\n`,
        );
        gateEvent("embed-similar", title, title);
        ctx.telemetry.article = {
          ...(ctx.telemetry.article ?? {}),
          titleEmbedSimilar: { closest, sim },
        };
      }
    }
  }
  // Relationship co-occurrence gate (R7C8: "subcontractors…poaching SpaceX
  // and Relativity engineers" shipped as the headline THESIS with zero
  // corpus support — R6C8's side-clause class at thesis level, in the exact
  // run where fact-guard was down). A relationship verb between capitalized
  // entities requires those entities to co-occur near such a verb somewhere
  // in the ground truth.
  {
    const REL_VERB =
      /\b(poach(es|ing)?|raid(s|ing)?|recruit(s|ing)?(\s+from)?|hir(es?|ing)\s+(away|from)|pull(s|ing)?\s+from|lur(es?|ing)|feed(s|ing)|supply(ing)?|supplies)\b/i;
    const relUngrounded = (cand: string): boolean => {
      const verbMatch = cand.match(REL_VERB);
      if (!verbMatch) return false;
      const ents = [...cand.matchAll(/\b[A-Z][\w]+(?:\s+[A-Z][\w]+)?\b/g)]
        .map((m) => m[0])
        .filter(
          (e) =>
            e.length >= 4 && !/^(The|And|But|Most|Now|New|Why|How)\b/.test(e),
        );
      if (ents.length < 2) return false;
      const stem = verbMatch[0].toLowerCase().slice(0, 4);
      const gt = groundTruth.toLowerCase();
      let idx = gt.indexOf(stem);
      while (idx !== -1) {
        const win = gt.slice(Math.max(0, idx - 300), idx + 300);
        if (ents.filter((e) => win.includes(e.toLowerCase())).length >= 2) {
          return false;
        }
        idx = gt.indexOf(stem, idx + 1);
      }
      return true;
    };
    if (relUngrounded(title)) {
      const alt3 = allCands
        .filter(
          (c) =>
            c.length >= 20 &&
            c.length <= 200 &&
            c !== title &&
            !relUngrounded(c),
        )
        .sort((a, b) => b.length - a.length);
      if (alt3.length > 0) {
        process.stdout.write(
          `        title carries an ungrounded entity relationship — re-picked\n`,
        );
        gateEvent("relationship", title, alt3[0]);
        title = alt3[0];
      } else {
        process.stdout.write(
          `        title relationship ungrounded, no clean candidate — keeping (recorded, publish-blocking)\n`,
        );
        gateEvent("relationship", title, title);
        ctx.telemetry.article = {
          ...(ctx.telemetry.article ?? {}),
          titleRelationshipUngrounded: true,
        };
      }
    }
  }
  // Quoted-span title gate (R7C6: headline quote-marked "went too far" —
  // a tense-shifted paraphrase; the body said "gone too far"). Every quoted
  // span in the title must appear verbatim in the article body.
  {
    const spans = (t: string): string[] =>
      [...t.matchAll(/[“"]([^”"]{4,})[”"]/g)].map((m) => m[1]);
    if (spans(title).some((q) => !body.includes(q))) {
      const alt2 = allCands
        .filter(
          (c) =>
            c.length >= 20 &&
            c.length <= 200 &&
            c !== title &&
            spans(c).every((q) => body.includes(q)),
        )
        .sort((a, b) => b.length - a.length);
      if (alt2.length > 0) {
        process.stdout.write(
          `        title quoted span not verbatim in body — re-picked\n`,
        );
        gateEvent("quote", title, alt2[0]);
        title = alt2[0];
      } else {
        process.stdout.write(
          `        title quoted span not verbatim in body, no clean candidate — keeping (recorded)\n`,
        );
        gateEvent("quote", title, title);
        ctx.telemetry.article = {
          ...(ctx.telemetry.article ?? {}),
          titleQuoteUnverbatim: true,
        };
      }
    }
  }
  // Schema bound WITHOUT mutilation (R7C1: a 205-char pick shipped sliced
  // mid-word — "…knows they e"). Prefer the longest candidate that FITS
  // (grounded, ≥20 chars); only when none fits, cut at a word boundary.
  if (title.length > 200) {
    const fitting = allCands
      .filter((c) => c.length >= 20 && c.length <= 200)
      .sort((a, b) => b.length - a.length);
    if (fitting.length > 0) {
      process.stdout.write(
        `        title over 200 chars (${title.length}) — re-picked longest fitting candidate (${fitting[0].length})\n`,
      );
      gateEvent("fit", title, fitting[0]);
      title = fitting[0];
    } else {
      // No candidate fits (R7C3: all 8 were 215-285 despite prompt guidance).
      // ONE surgical compress re-ask before any mechanical cut — a compressed
      // headline keeps the arc; a cut amputates it.
      let compressed = "";
      try {
        const compressPrompt = `Compress this headline to UNDER 200 characters. Keep the name, the strongest number, and the arc; cut everything else. Output ONLY the compressed headline, nothing else.\n\n${title}`;
        compressed = clean(
          await deps.withRetry(
            "title-compress",
            () =>
              deps.llm.complete({
                prompt: compressPrompt,
                model: deps.model,
                temperature: 0.3,
              }),
            { maxAttempts: 2, input: compressPrompt },
          ),
        );
      } catch {
        compressed = "";
      }
      if (compressed.length >= 20 && compressed.length <= 200) {
        process.stdout.write(
          `        title compressed ${title.length} → ${compressed.length} chars\n`,
        );
        gateEvent("fit", title, compressed);
        title = compressed;
      } else {
        // Mechanical cut is the LAST resort and a publish blocker: prefer a
        // SENTENCE boundary (a word cut ships an amputated thought — R7C1
        // mid-word, R7C3 dangling open quote, both as the live H1).
        const over = title;
        const head = title.slice(0, 200);
        const lastSentenceEnd = Math.max(
          head.lastIndexOf(". "),
          head.lastIndexOf("! "),
          head.lastIndexOf("? "),
          head.endsWith(".") || head.endsWith("!") || head.endsWith("?")
            ? head.length - 1
            : -1,
        );
        title =
          lastSentenceEnd >= 60
            ? head.slice(0, lastSentenceEnd + 1)
            : head.replace(/\s+\S*$/, "");
        process.stdout.write(
          `        title mechanically cut to ${title.length} chars — recorded as publish blocker\n`,
        );
        gateEvent("fit", over, title);
        ctx.telemetry.article = {
          ...(ctx.telemetry.article ?? {}),
          titleTruncated: true,
        };
      }
    }
  }
  // Round-8 #7: persist the full adjudication trail — every parsed candidate
  // VERBATIM plus every gate decision (from === to ⇒ flagged-but-kept) — so
  // a review can replay exactly what each gate saw and did. Lives in the
  // run's admin-Logs telemetry row; stdout above is unchanged.
  ctx.telemetry.article = {
    ...(ctx.telemetry.article ?? {}),
    titleGateTrace: { candidates: allCands, events: titleGateEvents },
  };
  return { content: body, title };
}

/** Pass 9 — derive SEO metadata from the finished article. */
export async function runSeo(
  article: string,
  deps: GateDeps,
): Promise<SeoMeta> {
  const prompt = `Produce metadata for the article below. Output EXACTLY one JSON object and nothing else:
{"title": "<the article's H1, cleaned>", "description": "<=300 chars, plain text", "seoTitle": "<=60 chars, keyword-led", "seoDescription": "<=160 chars", "tags": ["3-6 tags"], "keywords": ["3-6 search keywords"]}

ARTICLE:
${article.slice(0, 6000)}`;
  const h1 = article.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  let parsed: Partial<SeoMeta> = {};
  try {
    parsed = await deps.withRetry(
      "seo",
      () =>
        deps.llm.completeStructured({
          messages: [{ role: "user", content: prompt }],
          schema: SeoMetaSchema,
          schemaName: "seo_metadata",
          model: deps.model,
          temperature: 0.4,
        }),
      { input: prompt },
    );
  } catch {
    process.stdout.write(
      "  SEO metadata generation failed — using fallbacks\n",
    );
  }
  // Cap to the Blog API schema limits — the model overshoots the char counts.
  return {
    title: (parsed.title || h1 || "Untitled").slice(0, 200),
    description: (parsed.description || parsed.seoDescription || "").slice(
      0,
      300,
    ),
    seoTitle: (parsed.seoTitle || parsed.title || h1).slice(0, 200),
    seoDescription: (parsed.seoDescription || parsed.description || "").slice(
      0,
      300,
    ),
    tags: (Array.isArray(parsed.tags) ? parsed.tags : [])
      .filter((t) => typeof t === "string" && t.trim())
      .slice(0, 20),
    keywords: (Array.isArray(parsed.keywords) ? parsed.keywords : [])
      .filter((k) => typeof k === "string" && k.trim())
      .slice(0, 30),
  };
}
