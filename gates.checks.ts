/**
 * Checks for gates.ts — run: npx tsx gates.checks.ts
 *
 * The golden guard (services/blog/__tests__/golden.test.ts) replays LLM OUTPUTS
 * by call-order, so it does NOT catch a changed gate PROMPT — only that the right
 * NUMBER of calls fire in the right stage order. This check is the byte-lock for
 * the prompts themselves + the `chatCompletion([{role:"user",content:prompt}],
 * {model, temperature})` → `deps.llm.complete({prompt, model, temperature})`
 * conversion the carve performed.
 *
 * Method: run each moved gate with a CAPTURING `llm` stub (records the exact
 * {system, prompt, model, temperature} it receives) + fixture deps, and assert:
 *   1. the captured `prompt` is byte-identical to a verbatim reference (kept
 *      local here — the byte reference the carve must preserve),
 *   2. `model` === deps.model and `temperature` === the recorded value (proves
 *      the message conversion carried model/temperature unchanged),
 *   3. no `system` is set (the old call sites passed a user-only messages array).
 *
 * BRAND-LIFT: the brand-lift replaces any hardcoded publication literal
 * ("Example News (example.com)") with brand.publication. That literal appears
 * in NONE of these six prompts (the brand-lift is a no-op here) — asserted below
 * so a future edit that reintroduces it un-lifted is caught.
 */
import {
  runEdit,
  runFinalEdit,
  runFactGuard,
  runFactCheckAudit,
  runTitle,
  runSeo,
  corroborationBlockers,
  type GateDeps,
} from "./gates";

// Stub global fetch so runTitle's gatherSearchTerms (live Google autocomplete)
// is deterministic + network-free — returns the empty [query, []] shape, so the
// searchBlock collapses to "" (matches the golden test's fetch stub). Restored
// after the run.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify(["", []]), {
    status: 200,
  })) as typeof globalThis.fetch;

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${name}${detail ? `\n  ${detail}` : ""}\n`);
  }
}

// ── Capturing LLM + fixture deps ────────────────────────────────────────────
interface Captured {
  system?: string;
  prompt: string;
  model?: string;
  temperature?: number;
}
const captures: Captured[] = [];
// The stub returns a fixed, format-shaped reply so the gates' downstream parsing
// runs without errors. Free-text gates (edit/final-edit/fact-guard/fact-check)
// go through `complete` and just pass the string through. The STRUCTURED gates
// (title → headline_candidates, seo → seo_metadata) go through
// `completeStructured`: the reply is JSON, parsed + validated through the gate's
// own schema (what the live json_schema client guarantees). Both methods capture
// `{system, prompt, model, temperature}` — for the structured call the `prompt`
// is pulled from the user message — so the byte-lock asserts the exact prompt
// either way.
function makeDeps(llmReply: (prompt: string) => string): GateDeps {
  return {
    llm: {
      complete: async (args) => {
        captures.push({ ...args });
        return llmReply(args.prompt);
      },
      completeStructured: async (args) => {
        const userMsg =
          args.messages.find((m) => m.role === "user") ?? args.messages[0];
        const prompt = userMsg?.content ?? "";
        captures.push({
          prompt,
          model: args.model,
          temperature: args.temperature,
        });
        return args.schema.parse(JSON.parse(llmReply(prompt)));
      },
    },
    model: "test-model",
    // withRetry: pass-through (drops opts) — the gates only rely on it to invoke
    // fn() and return its result; telemetry recording isn't under test here.
    withRetry: async <T>(_label: string, fn: () => Promise<T>): Promise<T> =>
      fn(),
    ctx: {
      runId: "run_checks",
      telemetry: { mode: "topic", llmCalls: [], retries: [] },
      runArtifacts: [],
      recordArtifact: () => {},
      recordLlmCall: () => {},
      recordRetry: () => {},
    },
    gatherExemplars: () => [],
    fetchPriorTitles: async () => [],
    embedDedupSurvivors: async () => null,
    titleExemplarCount: 24,
    titleCollisionSim: 0.45,
    titleEmbedSim: 0.9,
    searchTermsCount: 12,
  };
}

// ── Verbatim reference prompts (the byte reference) ─────────────────────────
// Deliberate lock update, Part A (2026-07): instructions-at-end + craft lines
// (pictorial numbers, character economy, kicker taxonomy, restated-task tails)
// landed in the live prompts; these references carry the same bytes.
const refEdit = (draft: string): string =>
  `Line-edit this draft for publication. Apply the newspaper self-edit pass: kill passive voice and nominalizations, fix adjective pile-up and editorializing, cut throat-clearing and clichés, break fact-lists into narrative, cut repeated material (each statistic, sentence, and company list appears ONCE, at its strongest spot — rephrase later references instead of restating the number), thin stat pile-ups (where a paragraph strings three or more figures, keep the anchor number and fold the rest into one summarizing clause — or, when the figures are comparable salaries or market forecasts, into a small markdown table), recast raw figures the pictorial way (round unless precision is the point; prefer ratios — "one in four" over "24.7%"; give an incomprehensibly large number one visualizable equivalent), never let two number-heavy paragraphs sit adjacent, hunt abstract blobs and replace them with specific pictorial words ("severe personnel problems" → the actual thing: turnover; "resource companies" → oil rigs and mines), keep the piece MOVING by alternating the general and the concrete (a broad claim, then a tight-focus illustration, then back out — never several abstractions in a row), and when a stretch hides behind stacked citations, surface once and draw the prudent conclusion plainly in one sentence, ensure "said" attribution with at most two "according to" in the whole piece, vary sentence length, vary section-header shapes (never let every H2 share one construction — e.g. the "Topic — Subtitle" em-dash pattern on every header; mix plain noun phrases, claims, and the occasional question), and cut about 10%. Keep every markdown link and the H1 intact. Output ONLY the edited markdown article, nothing else.

DRAFT:
${draft}`;

const refFinalEdit = (article: string): string =>
  `You are the managing editor giving this piece its final read before print. You are NOT line-editing — read the whole thing for impact and integrity, and change only what's needed:
- Lede: does the first sentence earn attention? If it's throat-clearing or generic, rewrite it to open on a hard verified fact, a real named company's move, or a provocation — never an invented person, scene, or event (an undocumented demo, incident, or moment narrated with specific details is fabrication, even with no one named).
- Kicker (last paragraph): does it land on a concrete image or implication? Kill any "In conclusion", summary, or empty optimism. A kicker may CALL BACK to an earlier idea but must rephrase it — copying a sentence from an earlier section verbatim (or near-verbatim) is a repetition failure, not a callback.
- Spine: each section should earn the next. Cut or reorder any paragraph that stalls the through-line or could be shuffled without loss.
- Repetition: the same statistic, sentence, company list, or distinctive phrase must not appear twice in the piece — near-verbatim rewording counts as repetition ("pulling mid-career talent away from legacy defense primes" twice with two words swapped is still a repeat). Keep the strongest instance and cut or genuinely rework the other.
- Structural duplication: if two or more sections each enumerate the same set of named entities doing the same kind of thing (e.g. three sections that each list companies funding training programs), MERGE them into one section — that is shuffle-without-loss duplication even when the sentences differ. The same applies to FACT-CLUSTERS: when the same 2-3 distinctive figures travel together into two sections ("250 days + 8–15 months" appearing in both the backlog section and the bottleneck section), they belong in ONE place — rewording or swapping an acronym for the full name does not make it new material.
- Kill any AI tells, hedging, or hype that survived the line edit; enforce "said" attribution and at most two "according to" in the whole piece.
- INTEGRITY (most important): cut or fix any invented individual — a person whose story isn't in the reporting, including UNNAMED composites ("a former Google engineer who left to join…", "a 26-year-old researcher at…", an invented "she/he" you narrate). Replace any fictional protagonist with the real trend, named companies, and verified numbers. Every person, number, and quote must trace to the research.
- CHARACTER ECONOMY: develop one or two voices the reader gets to know; cut or fold in sources quoted once for a flat line; never keep a quote that only states the obvious — assert facts as facts; when a person appears, let them DO something, not just talk.
- PROOF VARIETY: within each section, mix the classes of evidence — a figure, an incident, a quote, an observation — never several of the same class stacked; prefer a mix of source LEVELS too (ground-level actors alongside official/desk-level voices), as far as the research supplies them.
- TRANSITIONS: let the end of each section point naturally into the next (a fact or image already on the page suggests the move); delete any empty connective scaffolding ("meanwhile", "it is worth noting") that exists only to change subject.
- THE ENDING: close with a kicker that seals the piece in memory using one of the three newspaper close types — CIRCLE BACK (echo the main theme through a symbol, voice, or image already in the piece — not a new proof), LOOK AHEAD (future material reads as speculation mid-piece but as a natural close at the end — move it there), or a plain SUMMARY close. Never a "revelation" ending, and the kicker must be expendable: no unique load-bearing fact or figure may appear ONLY in the final two paragraphs (move such facts up into the body).
Make surgical changes, not a rewrite — preserve the reporting and the voice. Keep every markdown link and heading intact. Output ONLY the finished markdown article, nothing else.

ARTICLE:
${article}`;

const refFactGuard = (article: string, research: string): string =>
  `You are a fact-checker. The ARTICLE must be grounded entirely in the RESEARCH DATA below. Find every FABRICATION the article presents as real but that is NOT in the research: (a) any INDIVIDUAL PERSON — named ("Maya Chen said…") or an unnamed composite ("a senior RF engineer who left FAANG…", "a 26-year-old researcher at…") — whose story isn't reported; AND (b) any SPECIFIC SCENE OR EVENT narrated with concrete details — a demo, incident, meeting, or moment with specific actions, measurements, timing, or dialogue ("At a robotics demo day, a humanoid robot tightened four bolts in thirty seconds; weeks later on the factory floor it failed, the bolts half a centimeter off") — that isn't documented in the research. Both are fabrications and must go, even when no person is named.

Rewrite the article to remove every fabrication:
- If it OPENS on an invented person, scene, or event, replace that opening with a grounded hook — a verified number, a real named company's move, or the documented trend — that still earns attention. The single most common failure is a vivid invented opening anecdote with no source; treat any undocumented opening scene as fabrication.
- Elsewhere, replace fabricated individuals and invented scenes/events with the real companies, numbers, and trend the research supports.
- SET-MEMBERSHIP integrity: when the article enumerates entities as members of a named set ("used by Google, ByteDance, and Tencent", "companies like X and Y are hiring for these roles", "adopters include..."), EVERY listed entity must appear in that set IN THE RESEARCH. Strip any member the research doesn't place there — prepending a marquee name to a real list, or presenting on-site companies as examples of a hiring trend the research never ties them to, is fabrication.
- RELATIONSHIP integrity: when the article asserts a specific relationship between named entities — X recruits or poaches talent from Y, X supplies or partners with Y, X competes with Y for Z, X is located in or moving to Z — the research must support THAT relationship, not merely mention both names. An entity that appears in the research in a DIFFERENT role (as an analogy, comparison, or strategy reference — "a playbook Apple pioneered") does NOT license naming it as a talent source, supplier, partner, or competitor; and an entity absent from the research entirely can carry no relationship at all. Strip the claim or soften it to what the research actually reports.
- QUOTED-SPAN integrity: every span inside quotation marks must appear VERBATIM in the research. If a source paraphrases or hedges ("X suggests it may have been …"), those words may NOT be quoted — either quote the source's actual quoted words or remove the quotation marks and attribute the paraphrase ("according to X's account"). A paraphrase wearing quotation marks is fabrication.
- TABLE-CELL attribution: for any figure inside a markdown table, the cited source must contain THAT figure for THAT role/level. EXCEPTION: a cell whose figure is present in the FIRST-PARTY BOARD DATA block is authoritative — accept it as-is and PREFER it over any web-scraped figure for that entity. Otherwise, if the source gives a different number or a different role, fix the cell or relabel the source — a synthesized number wearing a real source's name is fabrication.
- Verify ATTRIBUTION: where the article credits a figure to a source ("the IFR said", "McKinsey projects"), the research must credit that SAME source; if it credits a different one, fix the attribution. Attribute to the PRIMARY source: when the research shows a figure originated with a named study, agency, or major outlet and was merely re-cited by an aggregator/SEO blog, credit the originator — "Marketing Code's analysis found" for a BloombergNEF number launders authority and is an attribution failure. If the research gives NO identifiable source for a figure, CUT the figure or soften it to a magnitude ("hundreds of thousands of openings") — NEVER strip the credit and leave the precise number standing naked. Big claims (market sizes, "X% of companies", record investments, salary medians) MUST carry their source inline; an extraordinary number with no source reads as invented even when it isn't. This INCLUDES synthesized statistics: a quantitative claim the article presents as reported ("companies are offering 20–40% premiums in job postings") that appears in NO research source is a fabrication even if directionally plausible — soften it to an explicitly-derived observation ("the gap between X's $A and Y's $B suggests…") or cut it; NEVER let an unsourced number be the headline-bearing claim. And it includes LOOKS-SOURCED claims: when the article attributes a figure or projection to a named authority ("the American Welding Society has projected a shortage of 400,000 by 2027"), that authority AND that number must appear in the research — a confident citation you cannot find in the research is the model's memory wearing a source's name, and memory is frequently wrong; soften to a magnitude without the false credit, or cut.
- Keep everything already grounded: real named people/companies/events/numbers that ARE in the research stay. Keep every markdown link and heading. Preserve the voice and structure; change only what's fabricated or unsupported.
- Attribution: COUNT every "according to" in the article. If it appears more than TWICE, rewrite the excess into varied forms — "X reported", "per X", "X's data shows", "X found", or state the fact and cite the source once nearby. Leaving more than two "according to" is a failure.
- AI-tell words: remove every occurrence of these, rephrasing naturally — "delve", "landscape" (as in "the X landscape"), "leverage" (as a verb → "use"), "tapestry", "pivotal", "cornerstone", "robust", "navigate" (abstract), "realm", "underscore(s)", "comprehensive", "cutting-edge", "spearhead", "harness".

Output ONLY the corrected markdown article, nothing else.

RESEARCH DATA (the only facts that are real):
${research}

ARTICLE:
${article}\n\n=== YOUR TASK, RESTATED ===\nReturn the ARTICLE with every fabrication (per the definition at the top: undocumented individuals, and undocumented concrete scenes/events) removed or neutralized, and NOTHING else changed. When two sources conflict, trust the newer dated one. Output only the cleaned markdown article.`;

const refFactCheckAudit = (article: string, groundTruth: string): string =>
  `You are a fact-checker reviewing a PUBLISHED article against its RESEARCH. For every factual claim — especially every NUMBER, figure, date, named entity, and quoted span — rate whether the research supports it:
- FOUND: the claim (in substance) appears in the research.
- DERIVABLE: not stated verbatim, but it follows from the research by simple reasoning or arithmetic — e.g. a total that is the sum of sourced components. SHOW the derivation.
- NOT FOUND: the research contains nothing that supports it.
Output ONLY a markdown table: | Claim | Rating | Evidence / derivation / note |. One row per checked claim; lead with the load-bearing numbers. Be concise. This is an informational audit for a human reviewer — do NOT rewrite or comment on the article.

RESEARCH:
${groundTruth.slice(0, 120000)}

ARTICLE:
${article}\n\n=== YOUR TASK, RESTATED ===\nRate every claim as instructed above. Then add one final line starting "MISSING: " naming the single most important thing a beat reporter would add to this story that the research could support (or "MISSING: nothing material").`;

const refSeo = (article: string): string =>
  `Produce metadata for the article below. Output EXACTLY one JSON object and nothing else:
{"title": "<the article's H1, cleaned>", "description": "<=300 chars, plain text", "seoTitle": "<=60 chars, keyword-led", "seoDescription": "<=160 chars", "tags": ["3-6 tags"], "keywords": ["3-6 search keywords"]}

ARTICLE:
${article.slice(0, 6000)}`;

// runTitle's prompt depends on exemplars/searchTerms/priorTitles — with the
// fixture deps (all empty) styleBlock/searchBlock/priorTitles-block collapse to
// "", so the reference reduces to the no-blocks form. The body strip removes a
// leading H1 + rule; the fixture article has neither, so body === article.
const refTitle = (body: string, topic: string, angleAngle: string): string =>
  `You are the headline editor at a major newspaper. Your goal: a headline the reader CANNOT scroll past — maximum stop-power built entirely from REAL reported material. Curiosity, hard data, and shock value working together; never boilerplate clickbait.

NORTH STAR — the working title + angle this article was written to. Honor THIS story and its framing. But the working title is the long, descriptive label used to STEER the draft — it is NOT the final headline: write a tighter, sharper front-page version of the SAME story; never copy the working title or merely trim it.
- Working title: ${topic}
- Angle: ${angleAngle}

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

// ── Run each gate against the capturing stub + assert ───────────────────────
function diff(name: string, actual: string, expected: string): void {
  if (actual === expected) {
    ok(name, true);
    return;
  }
  let at = -1;
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
    if (actual[i] !== expected[i]) {
      at = i;
      break;
    }
  }
  ok(
    name,
    false,
    `prompt differs (len ${actual.length} vs ${expected.length}) first diff @${at}: ` +
      `actual=${JSON.stringify(actual.slice(Math.max(0, at), at + 50))} ` +
      `expected=${JSON.stringify(expected.slice(Math.max(0, at), at + 50))}`,
  );
}

async function main(): Promise<void> {
  // No literal in any gate prompt → all checked together at the end.
  const BRAND_LITERAL = "Example News (example.com)";

  // runEdit
  captures.length = 0;
  await runEdit(
    "DRAFT BODY",
    makeDeps(() => "edited"),
  );
  diff(
    "runEdit prompt byte-identical",
    captures[0].prompt,
    refEdit("DRAFT BODY"),
  );
  ok(
    "runEdit conversion: user-only, model+temperature",
    captures[0].system === undefined &&
      captures[0].model === "test-model" &&
      captures[0].temperature === 0.5,
  );
  const capturedEditPrompt = captures[0].prompt;

  // runFinalEdit
  captures.length = 0;
  await runFinalEdit(
    "ART BODY",
    makeDeps(() => "final"),
  );
  diff(
    "runFinalEdit prompt byte-identical",
    captures[0].prompt,
    refFinalEdit("ART BODY"),
  );
  ok(
    "runFinalEdit conversion: user-only, model+temperature",
    captures[0].system === undefined &&
      captures[0].model === "test-model" &&
      captures[0].temperature === 0.45,
  );
  const capturedFinalEditPrompt = captures[0].prompt;

  // runFactGuard
  captures.length = 0;
  await runFactGuard(
    "ART",
    "RESEARCH",
    makeDeps(() => "guarded"),
  );
  diff(
    "runFactGuard prompt byte-identical",
    captures[0].prompt,
    refFactGuard("ART", "RESEARCH"),
  );
  ok(
    "runFactGuard conversion: user-only, model+temperature",
    captures[0].system === undefined &&
      captures[0].model === "test-model" &&
      captures[0].temperature === 0.3,
  );
  const capturedFactGuardPrompt = captures[0].prompt;

  // runFactCheckAudit
  captures.length = 0;
  await runFactCheckAudit(
    "ART",
    "GROUND",
    makeDeps(() => "| a | b | c |"),
  );
  diff(
    "runFactCheckAudit prompt byte-identical",
    captures[0].prompt,
    refFactCheckAudit("ART", "GROUND"),
  );
  ok(
    "runFactCheckAudit conversion: user-only, model+temperature",
    captures[0].system === undefined &&
      captures[0].model === "test-model" &&
      captures[0].temperature === 0.2,
  );

  // runSeo
  captures.length = 0;
  await runSeo(
    "# Title\n\nbody",
    makeDeps(
      () =>
        '{"title":"T","description":"d","seoTitle":"s","seoDescription":"sd","tags":["x"],"keywords":["y"]}',
    ),
  );
  diff(
    "runSeo prompt byte-identical",
    captures[0].prompt,
    refSeo("# Title\n\nbody"),
  );
  ok(
    "runSeo conversion: user-only, model+temperature",
    captures[0].system === undefined &&
      captures[0].model === "test-model" &&
      captures[0].temperature === 0.4,
  );

  // runTitle (empty exemplars/searchTerms/priorTitles → no-blocks form). The
  // fixture article has no leading H1/rule, so body === article. The stub reply
  // is the structured { candidates, best } JSON the json_schema title pass now
  // returns (parsed + validated by makeDeps' completeStructured), so the gate
  // suite runs to completion.
  captures.length = 0;
  const titleReply = JSON.stringify({
    candidates: [
      "Alpha Beta Gamma Delta Epsilon Zeta",
      "Second Candidate Headline Here Now",
    ],
    best: "Alpha Beta Gamma Delta Epsilon Zeta",
  });
  const titleArticle = "Body line one of the article.\n\nMore body here.";
  await runTitle(
    titleArticle,
    "Working Topic Label",
    {
      category: "robotics",
      angle: "the angle phrasing",
      searchSeed: "robotics jobs",
    },
    "GROUND TRUTH",
    makeDeps(() => titleReply),
  );
  diff(
    "runTitle prompt byte-identical (no-blocks form)",
    captures[0].prompt,
    refTitle(titleArticle, "Working Topic Label", "the angle phrasing"),
  );
  ok(
    "runTitle conversion: user-only, model+temperature",
    captures[0].system === undefined &&
      captures[0].model === "test-model" &&
      captures[0].temperature === 0.8,
  );

  // ── Part A (2026-07): long-context prompt mechanics + craft lines ──────────
  // The task must be RESTATED after the research payload (lost-in-the-middle:
  // end-position attention wins); the edit passes carry the craft rules.
  ok(
    "fact-guard restates its task after the corpus",
    capturedFactGuardPrompt.lastIndexOf("YOUR TASK, RESTATED") >
      capturedFactGuardPrompt.lastIndexOf("RESEARCH DATA"),
  );
  ok(
    "line-edit teaches pictorial numbers",
    capturedEditPrompt.includes("one in four"),
  );
  ok(
    "managing editor enforces character economy and the kicker",
    capturedFinalEditPrompt.includes("develop one or two voices") &&
      capturedFinalEditPrompt.includes("no unique load-bearing fact"),
  );

  // ── Part B (2026-07): MAIN THEME threading — with `deps.theme` set, the
  // final-edit / fact-guard / title passes anchor on it (final-edit also gains
  // the nut rule). Theme UNSET keeps the exact old prompt bytes — that is the
  // byte-identity locks above, unchanged.
  const THEME = "Acme's widget push is remaking the market.";
  const THEME_HEAD = `MAIN THEME of this piece: ${THEME}\n\n`;

  captures.length = 0;
  await runFinalEdit("ART BODY", {
    ...makeDeps(() => "final"),
    theme: THEME,
  });
  const themedFinalEditPrompt = captures[0].prompt;
  ok(
    "final-edit opens with the MAIN THEME anchor when theme is set",
    themedFinalEditPrompt.startsWith(THEME_HEAD),
  );
  ok(
    "final-edit appends the nut rule to its change-list when theme is set",
    themedFinalEditPrompt.includes(
      "- THE NUT: the main theme material must be plainly stated within the first three paragraphs; if it is buried, surface it there.",
    ) &&
      themedFinalEditPrompt.indexOf("- THE NUT:") <
        themedFinalEditPrompt.indexOf("Make surgical changes"),
  );

  captures.length = 0;
  await runFactGuard("ART", "RESEARCH", {
    ...makeDeps(() => "guarded"),
    theme: THEME,
  });
  ok(
    "fact-guard opens with the MAIN THEME anchor when theme is set",
    captures[0].prompt.startsWith(THEME_HEAD),
  );

  captures.length = 0;
  await runTitle(
    titleArticle,
    "Working Topic Label",
    {
      category: "robotics",
      angle: "the angle phrasing",
      searchSeed: "robotics jobs",
    },
    "GROUND TRUTH",
    { ...makeDeps(() => titleReply), theme: THEME },
  );
  ok(
    "title pass opens with the MAIN THEME anchor when theme is set",
    captures[0].prompt.startsWith(THEME_HEAD),
  );

  // ── Brand-lift no-op: the literal appears in none of the gate prompts ──────
  const allPrompts = [
    refEdit("x"),
    refFinalEdit("x"),
    refFactGuard("x", "y"),
    refFactCheckAudit("x", "y"),
    refSeo("x"),
    refTitle("x", "t", "a"),
  ];
  ok(
    `brand-lift no-op: "${BRAND_LITERAL}" absent from all gate prompts`,
    allPrompts.every((p) => !p.includes(BRAND_LITERAL)),
  );

  // ── Part D1 (2026-07): corroborationBlockers — deterministic two-source
  // corroboration for lede/headline figures. RECORD-ONLY primitive: pure
  // (article, rawCorpus) → string[], no LLM, no ctx, no throw. The zerog
  // adapter pushes the strings onto its publish-blockers list (the A4 seam).
  const srcBlock = (n: number, url: string, body: string): string =>
    `### Source ${n} [tier 2]: Title ${n}\nURL: ${url}\n\n${body}`;

  // Lede scope = H1 + first 3 paragraphs. "3" (sub-10) and "2026" (year) are
  // candidate-regex matches that must be SKIPPED; the body's later figure is
  // out of scope entirely.
  const d1Article = [
    "# Space hiring hits 42,000 open roles on a $500M bet",
    "The sector added 42,000 roles this year, backed by a $500M raise and 3 new factories.",
    "Growth has held since 2026 across the industry.",
    "A third paragraph of context.",
    "## Later section",
    "Down here 99,999 appears once but body figures are out of D1 scope.",
  ].join("\n\n");

  const twoDomains = [
    // comma-less "42000" in source 2 proves comma-normalized matching;
    // "www." on source 1 proves hostname stripping.
    srcBlock(
      1,
      "https://www.techcrunch.com/a",
      "TechCrunch reports 42,000 roles and the $500M raise.",
    ),
    srcBlock(
      2,
      "https://spacenews.com/b",
      "SpaceNews counts 42000 roles; the $500M round closed.",
    ),
  ].join("\n\n");
  ok(
    "corroboration: two distinct domains → no blockers (year + sub-10 skipped)",
    corroborationBlockers(d1Article, twoDomains).length === 0,
  );

  const oneDomain = [
    srcBlock(
      1,
      "https://www.techcrunch.com/a",
      "TechCrunch reports 42,000 roles and the $500M raise.",
    ),
    srcBlock(2, "https://spacenews.com/b", "SpaceNews covers the $500M round only."),
  ].join("\n\n");
  const oneBlockers = corroborationBlockers(d1Article, oneDomain);
  ok(
    "corroboration: single-domain figure → exact blocker string (www-stripped)",
    oneBlockers.length === 1 &&
      oneBlockers[0] === 'single-source-figure: "42,000" seen only via techcrunch.com',
    JSON.stringify(oneBlockers),
  );

  // FIRST-PARTY BOARD DATA is authoritative on its own (the same exception the
  // fact-guard's table-cell rule makes) — a board-only figure needs no second
  // web domain. The block rides at the corpus TAIL, after the last `### Source`
  // (the real groundTruth shape) — and must not credit a web source's domain.
  const boardCorpus =
    [
      srcBlock(1, "https://spacenews.com/b", "SpaceNews covers the $500M round."),
      srcBlock(2, "https://techcrunch.com/a", "TechCrunch also has the $500M raise."),
    ].join("\n\n") +
    "\n\n## FIRST-PARTY BOARD DATA (the brand's own job board — verified)\n\nAcme: 42,000 open roles";
  ok(
    "corroboration: FIRST-PARTY BOARD DATA containment corroborates by itself",
    corroborationBlockers(d1Article, boardCorpus).length === 0,
    JSON.stringify(corroborationBlockers(d1Article, boardCorpus)),
  );

  ok(
    "corroboration: bare years and sub-10 figures never flag (even uncorroborated)",
    corroborationBlockers(
      "# The 2026 outlook\n\nBy 2027, 3 firms and 9 labs remain.\n\nMore.\n\nEven more.",
      "",
    ).length === 0,
  );

  const mBlockers = corroborationBlockers(
    "# A $5M seed\n\nThe $5M seed closed quietly.\n\nMore.\n\nEven more.",
    srcBlock(1, "https://a.com/x", "the $5M seed"),
  );
  ok(
    'corroboration: "$5M" is 5e6 (suffix multiplier), not sub-10 — single-sourced → flags',
    mBlockers.length === 1 &&
      mBlockers[0] === 'single-source-figure: "$5M" seen only via a.com',
    JSON.stringify(mBlockers),
  );
}

main()
  .then(() => {
    globalThis.fetch = realFetch;
    process.stdout.write(
      failed === 0
        ? `\nALL ${passed} checks passed\n`
        : `\n${failed} FAILED, ${passed} passed\n`,
    );
    if (failed > 0) process.exit(1);
  })
  .catch((err: unknown) => {
    globalThis.fetch = realFetch;
    process.stdout.write(`\nCHECK THREW: ${String(err)}\n`);
    process.exit(1);
  });
