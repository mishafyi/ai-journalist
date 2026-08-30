/**
 * presets/news-desk.ts — the news-desk path. Part 1: the author-version
 * contract (checkAuthorVersionContract) and its retry-until-contract composer.
 * Part 2 (createNewsDesk) orchestrates: trending → resolution → floors →
 * verified parallel → ONE columnist's fused column → publish.
 */
import { mentionsName, namesEvent, NO_PARALLEL_PHRASE, runEdit, runFactCheckAudit } from "../gates";
import { checkClaims } from "../claim-check";
import { createHeadlineMatcher } from "../matching";
import { pickLeadImage } from "../sources/lead-image";
import type { ImageSearchConfig } from "../sources/lead-image";
import type { LeadImage } from "../sources/lead-image";
import { proposeParallels, verifyParallel } from "../parallels";
import type { ParallelCandidate, VerifiedParallel } from "../parallels";
import type { GeneratedArticle } from "../pipeline";
import type {
  BrandProfile,
  CoveredTopic,
  Embedder,
  GeneratedPost,
  LlmClient,
  PersonaProfile,
  SearchClient,
  Sink,
} from "../ports";
import {
  createResearchStack,
  extractEvidence,
  hostOf,
  isBlockedHost,
  isTeaserContent,
  DEFAULT_BLOCKED_HOSTS,
} from "../research";
import { createRunContext } from "../run-context";
import { z } from "zod";
import type { DatagodClient } from "../clients/datagod";
import { fetchCoverage, fetchTrendingStories, GN_US } from "../sources/google-news";
import type { Coverage } from "../sources/google-news";
import type { TrendingStory } from "../sources/google-news";
import { createNewswire } from "../sources/newswire";
import { provenanceOf } from "../sources/provenance";
import type { OutletFeed, OutletItem } from "../sources/newswire";
import { createDefaultInternals } from "./default";
import { lengthSafe, stripPreambleAndFence } from "./text-defaults";


/** The section taxonomy — modeled on the NYT / WSJ / Washington Post mastheads,
 *  narrowed to the beats this desk actually covers. The tagging call picks
 *  EXACTLY ONE per story, so every article files under a real section. */
export const SECTIONS = [
  "World",
  "Politics",
  "National Security",
  "Business",
  "Economy",
  "Technology",
  "Science & Health",
  "Climate",
  "Culture",
] as const;
export type Section = (typeof SECTIONS)[number];

/** The neutral example persona (spec) — method over ideology. Realist and
 *  Systems Thinker were cut 2026-07-24: nothing referenced them. */
export const PERSONAS: { historian: PersonaProfile } = {
  historian: {
    name: "The Historian",
    method:
      "Read today's event against the long record. Anchor every judgment in the verified historical parallel and in dated, sourced facts.",
    priors:
      "Structural forces outlast personalities; most 'unprecedented' events have precedents; institutions adapt slower than markets.",
    voice: "Measured, concrete, professorial without jargon. Short sentences when the point lands.",
  },
};
/** Chapter titles that say nothing: newspaper section labels, essay furniture,
 *  or the word we are explicitly retiring ("Analysis — <Name>"). */
const GENERIC_HEADING_RE =
  /^(the\s+)?(analysis|analyses|introduction|intro|conclusion|conclusions|background|context|overview|summary|commentary|opinion|takeaway|takeaways|discussion|body|what\s+happened|the\s+numbers|the\s+facts|reactions?|sources?|final\s+thoughts?)\b/i;

/** Reader-facing dek from a column: the first PROSE paragraph — chapter
 *  headings stripped, markdown flattened — cut at a sentence boundary. A raw
 *  slice of the markdown put "## Chapter Title…" into cards and og tags
 *  (seen live 2026-07-24). */
export function dekFrom(markdown: string): string {
  const para = markdown
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s+.*$/gm, "").trim())
    .find((p) => p !== "");
  if (para === undefined) return "";
  const prose = para
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (prose.length <= 200) return prose;
  const cut = prose.slice(0, 200);
  // A complete short sentence beats a chopped long one (live 2026-07-26: the
  // second sentence ran past the cap and the dek ended mid-name). Take the
  // last sentence end inside the cap however early it falls; only a
  // paragraph with NO sentence break gets cut, and then at a word boundary.
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (end > 0) return cut.slice(0, end + 1);
  const word = cut.slice(0, 180).replace(/\s+\S*$/, "");
  return `${word.trimEnd()}…`;
}

/** Mechanical contract for a fused author version (operator, 2026-07-23:
 *  "whole retelling AND analysis from author perspective, shorter, capped").
 *  The piece retells the reporting (so outlet attribution is REQUIRED here,
 *  unlike the columns contract where the neutral retell carried sourcing)
 *  and argues the author's take (bottom line + verified-parallel rules). */
export function checkAuthorVersionContract(
  version: string,
  args: { outletNames: readonly string[]; parallelEvent: string | null; wordCap: number; writerName: string },
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const words = version.trim().split(/\s+/).length;
  if (words < 300) failures.push(`too short: ${words} words (floor 300)`);
  if (words > args.wordCap) failures.push(`over the cap: ${words} words (cap ${args.wordCap})`);
  // Case-insensitive (2026-07-23 live failure: "found BBC" while the column
  // credited "the Guardian" — lowercase articles must count as attribution).
  const mentioned = args.outletNames.filter((o) => mentionsName(version, o));
  if (mentioned.length < 2)
    failures.push(
      `must attribute the reporting to at least 2 outlets by name (found ${mentioned.length === 0 ? "none" : mentioned.join(", ")})`,
    );
  // No labeled-verdict requirement: the committed close is enforced by the
  // prompt ("argue one decided position"), not a "**The bottom line:**" tag that
  // read as formulaic across every column (operator, 2026-07-28). The label is
  // stripped in post-processing if the model reaches for it anyway.
  if (args.parallelEvent !== null) {
    // namesEvent: typography-, case-, and leading-article-insensitive — the
    // exact-includes() false-negative class rejected correct columns twice
    // live on 2026-07-23 ("Smoot–Hawley" en dash; "the Dust Bowl" case).
    if (!namesEvent(version, args.parallelEvent))
      failures.push(`must name the verified parallel ("${args.parallelEvent}")`);
  } else if (!version.includes(NO_PARALLEL_PHRASE)) {
    failures.push(`no verified parallel: must include "${NO_PARALLEL_PHRASE}" verbatim`);
  }
  if (/wikipedia|encyclopedia/i.test(version)) failures.push("must not mention Wikipedia/encyclopedias (verification is internal)");
  // Chapters are required, and each title must be ORIGINAL — written from what
  // that chapter actually argues. A generic label ("Analysis", "Context") or the
  // columnist's own name is exactly what we're replacing.
  const headings = [...version.matchAll(/^##+\s+(.+)$/gm)].map((m) => m[1].trim());
  if (headings.length < 2) {
    failures.push(`needs at least 2 chapter headings ("## ..."), found ${headings.length}`);
  }
  if (headings.length > 5) failures.push(`too many chapters: ${headings.length} (max 5)`);
  for (const h of headings) {
    if (GENERIC_HEADING_RE.test(h)) {
      failures.push(`heading "${h}" is a generic label — title it from what the chapter argues`);
    }
    if (args.writerName !== "" && h.toLowerCase().includes(args.writerName.toLowerCase())) {
      failures.push(`heading "${h}" names the columnist — title it from the chapter's content`);
    }
    if (h.split(/\s+/).length < 3) failures.push(`heading "${h}" is too thin to be a real chapter title`);
  }
  return { ok: failures.length === 0, failures };
}

/** Compose one COMPLETE author version: the story retold through the
 *  persona's lens (facts + attribution from the evidence) fused with their
 *  decided take. Same retry-until-contract shape as composeAnalysis. */
export async function composeAuthorVersion(args: {
  llm: LlmClient;
  persona: PersonaProfile;
  storyHeadline: string;
  evidenceBlock: string;
  outletNames: readonly string[];
  parallel: VerifiedParallel | null;
  wordCap: number;
  maxAttempts: number;
  model?: string;
  log?: (line: string) => void;
}): Promise<string> {
  const { persona } = args;
  const parallel = args.parallel !== null && args.parallel.event.trim() !== "" ? args.parallel : null;
  const parallelBlock =
    parallel === null
      ? `NO parallel survived verification. You MUST include this sentence verbatim: "${NO_PARALLEL_PHRASE}" — then argue on the evidence alone.`
      : `YOUR CENTRAL PARALLEL: "${parallel.event}". VERIFIED BACKGROUND (internal fact-check — never mention Wikipedia or any encyclopedia in your column; if your memory of this history conflicts with the background, THE BACKGROUND WINS — correct your history to it):\n${parallel.extract}\nClaimed similarity: ${parallel.claimedSimilarity}\nName the parallel event in your argument (by its name as given above) and COMMIT to it: argue why this precedent supports your judgment completely — the shared mechanism, not surface resemblance. Never hedge the parallel or list where it fails; if you find yourself needing disclaimers, you are arguing it wrong (operator, 2026-07-26: one side, supported by the precedent, argued all the way).`;

  // The desk's standing editorial tests live in the SYSTEM prompt, with who
  // the columnist is — they are how this paper writes, not instructions about
  // today's story. Keeping them out of the per-story requirement list also
  // stops them crowding out the mechanical ones the contract actually checks
  // (outlet attribution, the named parallel, chapter headings), which a small
  // local model will drop first when a prompt grows.
  //
  // The second test is the delicate one: stating the opposing case at its
  // strongest reads like "on the other hand" unless the prompt says otherwise,
  // and this paper deliberately publishes committed op-eds. So it is written
  // as an instrument of the argument — you state their best case BECAUSE
  // beating the weak one proves nothing — never as balance.
  const standards = `THE DESK'S STANDING TESTS — every column you write must pass all three:\n• THE VOTING BOOTH. Keep what a citizen could actually carry into a polling place, a council meeting, or an argument over a ballot measure: the facts that change what someone does or how they vote. Spend your words there, not on colour that merely entertains.\n• THE STRONGEST OPPOSING CASE. Put the other side at its best — the version its most capable advocate would recognise, its strongest evidence, not a pundit's soundbite and not a strawman you built to knock down — and then defeat it. This is NOT balance and it never softens your verdict: you state their best case precisely because beating the weak one proves nothing, and a reader can tell the difference.\n• THE LONG RECORD. Today's event is the surface of something older. Say what the historical pattern predicts here and what would have to be true for this time to be different. Never call a thing unprecedented unless you can show that nothing precedes it.`;

  const system = `You are ${persona.name}, an opinion columnist with a decided worldview, writing your COMPLETE column on today's story: you retell what happened AND argue what it means, fused in one voice — yours. The facts belong to the reporting; the framing, emphasis, and verdict belong to you.\n\nPERSONA: ${persona.name}${persona.bio === undefined ? "" : `\nBiography (you ARE this person — let the background drive your style, word choice, references, and lean; live it, never recite it): ${persona.bio}`}\nMethod: ${persona.method}\nPriors: ${persona.priors}\nVoice: ${persona.voice}\n\n${standards}`;

  const target = `${Math.round(args.wordCap * 0.7)}-${Math.round(args.wordCap * 0.85)}`;
  const base = `TODAY'S STORY: ${args.storyHeadline}\n\nTHE EVIDENCE (your ONLY source of current facts — quotes verbatim, numbers exact):\n${args.evidenceBlock}\n\n${parallelBlock}\n\nWrite your complete column now. Requirements:\n- Retell the story's essentials through your lens: who did what, the key figures and quotes — attributing the reporting in prose to at least TWO of these outlets by name: ${args.outletNames.join(", ")}\n- Never invent facts beyond the evidence; interpretation is yours, facts are theirs\n- Argue ONE decided position with force; no both-sides hedging, no "time will tell"\n- End on ONE committed verdict — a final paragraph that lands your position hard, no hedging. Do NOT label it ("The bottom line", "In sum", "The upshot", "In conclusion"): a columnist doesn't announce the verdict, they just deliver it\n- Break the piece into 2-4 chapters, each opening with a markdown heading ("## ..."). EVERY chapter title must be ORIGINAL and written from what THAT chapter actually says — a specific line a reader could only have written after reading it. NEVER use a generic label ("Analysis", "Context", "Background", "Conclusion", "What happened", "The numbers") and NEVER put your own name in a heading
- This is an OP-ED, not a briefing: be very opinionated. Take a side in the first paragraph and press it all the way through — name who is wrong and say why, make the judgment call the reporting won't, and let your convictions show in the verbs. No neutrality, no "on the other hand", no hedging\n- ${target} words, hard cap ${args.wordCap} — unmistakably in your voice.`;

  // Retry = REVISE the previous draft, never regenerate: full rewrites under
  // failure feedback oscillate (live 2026-07-23 — each attempt satisfied the
  // previous failure and broke a different constraint; three attempts, three
  // disjoint failures). Revision keeps what already passed.
  let lastFailures: string[] = [];
  let lastDraft = "";
  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? base
        : `${base}\n\nYOUR PREVIOUS DRAFT:\n${lastDraft}\n\nIt failed the contract on exactly these points:\n${lastFailures.map((f) => `- ${f}`).join("\n")}\nREVISE the draft above: change only what those failures demand and keep everything else — every requirement it already met must stay met. Output the full revised column.`;
    const version = await args.llm.complete({
      system,
      prompt,
      temperature: 0.4,
      ...(args.model === undefined ? {} : { model: args.model }),
    });
    const verdict = checkAuthorVersionContract(version, {
      outletNames: args.outletNames,
      parallelEvent: parallel === null ? null : parallel.event,
      wordCap: args.wordCap,
      writerName: persona.name,
    });
    if (verdict.ok) return version;
    lastFailures = verdict.failures;
    lastDraft = version;
    args.log?.(`author version (${persona.name}) attempt ${attempt}/${args.maxAttempts} failed contract: ${verdict.failures.join(" | ")}`);
  }
  throw new Error(`author version (${persona.name}) failed the contract after ${args.maxAttempts} attempts: ${lastFailures.join(" | ")}`);
}

/** Pass 6 for the desk: line-edit a contract-passing author version (the
 *  newspaper self-edit pass, gates.runEdit) without ever weakening the gate.
 *  The edited text ships only when it stays inside lengthSafe's 70–130% band
 *  AND still passes checkAuthorVersionContract; any rejection — or a thrown
 *  edit call — keeps the draft, so the desk's hot path grows no new failure
 *  mode. The word floor injected into the prompt is the DRAFT's own size
 *  (never below the contract's 300), not runEdit's feature default of 1200:
 *  without a number near the real size the editor shreds a piece (43–54%
 *  keeps, 2026-07-08), and 1200 would tell a 700-word column to pad. */
export async function lineEditAuthorVersion(args: {
  llm: LlmClient;
  body: string;
  contract: { outletNames: readonly string[]; parallelEvent: string | null; wordCap: number; writerName: string };
  log?: (line: string) => void;
}): Promise<string> {
  const words = args.body.trim().split(/\s+/).length;
  try {
    const raw = await runEdit(args.body, {
      llm: args.llm,
      model: "",
      withRetry: async (_label, fn) => fn(),
      ctx: createRunContext("news-desk-line-edit"),
      gatherExemplars: () => [],
      fetchPriorTitles: async () => [],
      embedDedupSurvivors: async () => null,
      titleExemplarCount: 0,
      titleCollisionSim: 0,
      titleEmbedSim: 0,
      searchTermsCount: 0,
      editWordFloor: Math.max(300, Math.round(words * 0.85)),
    });
    const edited = stripPreambleAndFence(raw).trim();
    if (lengthSafe("author-line-edit", args.body, edited) !== edited) {
      args.log?.("news-desk: line edit rejected (outside the 70-130% length band) — keeping the draft");
      return args.body;
    }
    const verdict = checkAuthorVersionContract(edited, args.contract);
    if (!verdict.ok) {
      args.log?.(`news-desk: line edit rejected (broke the contract: ${verdict.failures.join(" | ")}) — keeping the draft`);
      return args.body;
    }
    args.log?.(`news-desk: line edit kept (${words} → ${edited.split(/\s+/).length} words)`);
    return edited;
  } catch (err: unknown) {
    args.log?.(`news-desk: line edit failed (best-effort, keeping the draft): ${String(err)}`);
    return args.body;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Part 2: createNewsDesk — the orchestration. Trending (Google News) →
// resolution against ALL outlet indexes (newswire + matching, ≥minSources
// scrapable floor, next-story fallback) → full-scrape per-outlet extraction →
// the FIXED retell plan through EngineInternals.generate → verified parallel →
// contract-gated Analysis → assembled markdown + ## Sources → sink.publish.
// Every ranking/matching/counting decision is mechanical; the model only
// extracts, retells, and writes under contract.
// ───────────────────────────────────────────────────────────────────────────

/** The news desk's tunable knobs — all explicit, no defaults (spec values in
 *  comments; matchThreshold semantics depend on the matcher backend). */
export interface NewsDeskKnobs {
  trendingLimit: number; // 20
  minSources: number; // 3 — never write thin
  pagesMax: number; // 6
  chunkChars: number; // 24000
  maxChunksPerPage: number; // 4
  minContentChars: number; // 400
  matchThreshold: number; // 0.62 with embedder, pass 0.35 when trigram-only
  coveredThreshold: number; // same semantics, for covered-story skip
  parallelCount: number; // 4
  parallelMinScore: number; // 0.3
  analysisAttempts: number; // 3
}

/**
 * Wire the news-desk run. `search` is the RAW client WITH `scrape()` — the
 * hardened research facade (memoized + gap-gated scrapes) is built internally.
 * `trendingImpl`/`indexImpl`/`internalsFactory`/`parallelFetchImpl` are test
 * seams whose defaults are the real implementations, so offline checks drive
 * the REAL orchestration through fakes at exactly those seams.
 */
// ───────────────────────────────────────────────────────────────────────────
// Primary-data plays (DataGod) — WHICH API for WHICH story, as data.
// Descriptions come from datagod's own docs/endpoints.csv "Use for" text;
// the selection LLM call picks 0-2 plays from THIS menu with tightly
// constrained params — it never invents endpoints (gemma-narrowing rule).
// ───────────────────────────────────────────────────────────────────────────

export interface DataPlay {
  id: string;
  /** When to use it — shown verbatim to the selection LLM. */
  useFor: string;
  /** Evidence-block framing override. Default presents the payload as
   *  authoritative primary data; reference-class plays (encyclopedic
   *  background) override it so the column never cites an encyclopedia —
   *  the contract rejects that. */
  evidenceLabel?: string;
  /** Build the request from validated params. */
  request(params: { seriesId?: string; query?: string; ticker?: string; country?: string }): {
    path: string;
    params?: Record<string, string | number>;
  } | null;
}

export const FRED_SERIES_WHITELIST = [
  "GDP", "CPIAUCSL", "UNRATE", "FEDFUNDS", "DGS10", "SP500", "DCOILWTICO",
] as const;

export const WORLDBANK_INDICATOR_WHITELIST = [
  "NY.GDP.MKTP.CD", "NY.GDP.MKTP.KD.ZG", "FP.CPI.TOTL.ZG", "SL.UEM.TOTL.ZS", "SP.POP.TOTL",
] as const;

export const IMF_WEO_SERIES_WHITELIST = ["NGDP_RPCH", "PCPIPCH", "LUR", "GGXWDG_NGDP", "BCA_NGDPD"] as const;

const ISO_COUNTRY_RE = /^[A-Za-z]{2,3}(;[A-Za-z]{2,3}){0,3}$/;
const EONET_CATEGORIES = ["wildfires", "severeStorms", "volcanoes", "floods"] as const;

export const DATA_PLAYS: readonly DataPlay[] = [
  {
    id: "fred_series",
    useFor:
      "US macroeconomic indicators the story turns on: GDP growth, inflation/CPI (CPIAUCSL), unemployment (UNRATE), Fed interest rates (FEDFUNDS), 10-year Treasury yield (DGS10), S&P 500 (SP500), WTI crude oil price (DCOILWTICO). seriesId MUST be one of the whitelist.",
    request: (p) =>
      p.seriesId !== undefined && (FRED_SERIES_WHITELIST as readonly string[]).includes(p.seriesId)
        ? { path: `/fred/${p.seriesId}`, params: { limit: 36, sort_order: "desc" } }
        : null,
  },
  {
    id: "usaspending_search",
    useFor:
      "Who received US federal money: contracts, grants, award amounts, defense or agency spending. query = 1-3 plain keywords (a contractor, program, or agency named in the story).",
    request: (p) =>
      p.query !== undefined && p.query.trim().length >= 3 && p.query.length <= 60
        ? { path: "/usaspending/search", params: { q: p.query.trim(), limit: 5 } }
        : null,
  },
  {
    id: "nasdaq_price",
    useFor:
      "Current share price and day move for a US-listed company central to the story. ticker = its exchange symbol (e.g. AAPL, GM, LMT).",
    request: (p) =>
      p.ticker !== undefined && /^[A-Z.\-]{1,8}$/.test(p.ticker)
        ? { path: `/nasdaq/price/${p.ticker}`, params: {} }
        : null,
  },
  {
    id: "treasury_debt",
    useFor:
      "US national debt totals (debt to the penny) when the story is about federal debt, deficits, or fiscal capacity.",
    request: () => ({ path: "/treasury/debt", params: { limit: 5 } }),
  },
  {
    id: "worldbank_indicator",
    useFor:
      "A named country's headline macro figure in an INTERNATIONAL story: GDP (NY.GDP.MKTP.CD), GDP growth % (NY.GDP.MKTP.KD.ZG), inflation % (FP.CPI.TOTL.ZG), unemployment % (SL.UEM.TOTL.ZS), population (SP.POP.TOTL). seriesId MUST be one of those World Bank codes; country = ISO country code(s), semicolon-separated (e.g. \"fr\" or \"us;cn\").",
    request: (p) =>
      p.seriesId !== undefined &&
      (WORLDBANK_INDICATOR_WHITELIST as readonly string[]).includes(p.seriesId) &&
      p.country !== undefined && ISO_COUNTRY_RE.test(p.country)
        ? { path: `/worldbank/${p.seriesId}`, params: { countries: p.country.toLowerCase(), per_page: 60, date_range: "2015:2026" } }
        : null,
  },
  {
    id: "imf_weo",
    useFor:
      "IMF World Economic Outlook figures for a country, INCLUDING IMF FORECAST years: real GDP growth (NGDP_RPCH), inflation (PCPIPCH), unemployment (LUR), government debt %GDP (GGXWDG_NGDP), current account %GDP (BCA_NGDPD). seriesId MUST be one of those WEO codes; country = ONE ISO3 code (e.g. FRA).",
    request: (p) =>
      p.seriesId !== undefined &&
      (IMF_WEO_SERIES_WHITELIST as readonly string[]).includes(p.seriesId) &&
      p.country !== undefined && /^[A-Za-z]{3}$/.test(p.country)
        ? { path: `/imf/WEO/${p.country.toUpperCase()}.${p.seriesId}`, params: { limit: 60 } }
        : null,
  },
  {
    id: "usgs_quakes",
    useFor:
      "An earthquake story: authoritative magnitudes, locations and times straight from USGS.",
    request: () => ({ path: "/usgs/earthquakes", params: { minmagnitude: 5, limit: 10, orderby: "time" } }),
  },
  {
    id: "eonet_events",
    useFor:
      "A wildfire, severe-storm, volcano or flood story: NASA's tracker of active named natural events. query MUST be one of: wildfires, severeStorms, volcanoes, floods.",
    request: (p) =>
      p.query !== undefined && (EONET_CATEGORIES as readonly string[]).includes(p.query)
        ? { path: "/eonet/events", params: { category: p.query, status: "open", limit: 10 } }
        : null,
  },
  {
    id: "wikipedia_summary",
    useFor:
      "Stable background on ONE central entity the coverage assumes the reader knows (a person, organization, place or treaty): grounds names, dates and roles. query = the entity's name.",
    evidenceLabel:
      "REFERENCE BACKGROUND (for your own grounding of names, dates and roles — NEVER cite or mention an encyclopedia in the column)",
    request: (p) =>
      p.query !== undefined && p.query.trim().length >= 2 && p.query.length <= 80
        ? { path: `/wikipedia/summary/${encodeURIComponent(p.query.trim())}`, params: {} }
        : null,
  },
  {
    id: "edgar_filings",
    useFor:
      "The story centers on a specific US-listed company's finances, results, guidance, risks, or an SEC matter: pull the company's own profile and filing history from the regulator (SEC EDGAR) so figures come from official filings, not a re-tell. ticker = its exchange symbol (e.g. TSLA, AAPL).",
    request: (p) =>
      p.ticker !== undefined && /^[A-Z.\-]{1,8}$/.test(p.ticker)
        ? { path: `/edgar/company/${p.ticker}`, params: {} }
        : null,
  },
];

/** Reader-facing titles for the whitelisted FRED series (chart captions). */
export const FRED_TITLES: Record<string, string> = {
  GDP: "US gross domestic product",
  CPIAUCSL: "US consumer price index",
  UNRATE: "US unemployment rate",
  FEDFUNDS: "Federal funds rate",
  DGS10: "10-year Treasury yield",
  SP500: "S&P 500",
  DCOILWTICO: "WTI crude oil price",
};

/** Chart.js line-chart URL for a FRED series, rendered by QuickChart —
 *  a maintained chart service, not hand-rolled SVG (operator, 2026-07-25).
 *  Pure: takes the observations the play already fetched, newest-first as
 *  FRED returns them, and charts them oldest→newest. Null when the series
 *  is too thin to plot honestly. */
export function fredChartUrl(seriesId: string, observations: readonly { date: string; value: string }[]): string | null {
  const points = observations
    .filter((o) => o.value !== "." && Number.isFinite(Number(o.value)))
    .slice(0, 36)
    .reverse();
  if (points.length < 6) return null;
  const config = {
    type: "line",
    data: {
      labels: points.map((o) => o.date),
      datasets: [
        {
          label: FRED_TITLES[seriesId] ?? seriesId,
          data: points.map((o) => Number(o.value)),
          borderColor: "#e4572e",
          backgroundColor: "rgba(228,87,46,0.08)",
          fill: true,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.2,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false }, title: { display: true, text: FRED_TITLES[seriesId] ?? seriesId } },
      scales: { x: { ticks: { maxTicksLimit: 6 } } },
    },
  };
  return `https://quickchart.io/chart?w=760&h=380&bkg=%23f7f6f2&c=${encodeURIComponent(JSON.stringify(config))}`;
}

const DataPlayPick = z.object({
  plays: z
    .array(
      z.object({
        id: z.string(),
        seriesId: z.string().optional(),
        query: z.string().optional(),
        ticker: z.string().optional(),
        country: z.string().optional(),
      }),
    )
    .max(2),
});

/** Select 0-2 primary-data plays for a story (one narrow schema-constrained
 *  call), fetch them best-effort, and compact each payload into evidence
 *  bullets via the proven chunked extractor. Also renders the FIRST fetched
 *  FRED series as a chart (QuickChart) for the article body. Empty results
 *  when nothing applies — data plays must never block an article. */
export async function gatherPrimaryData(args: {
  llm: LlmClient;
  datagod: DatagodClient;
  plays: readonly DataPlay[];
  storyHeadline: string;
  evidenceHead: string;
  model?: string;
  log?: (line: string) => void;
  recordArtifact?: (label: string, content: string) => void;
}): Promise<{ block: string; chartMarkdown: string }> {
  const menu = args.plays
    .map((p) => `- id "${p.id}": ${p.useFor}`)
    .join("\n");
  let picks: z.infer<typeof DataPlayPick>;
  try {
    picks = await args.llm.completeStructured({
      messages: [
        {
          role: "system",
          content:
            "You decide whether PRIMARY DATA would materially strengthen a news article, and which of a fixed menu of data plays to run. Be selective: most stories need NONE — return an empty plays array unless an authoritative figure from the menu would clearly sharpen this specific story. Never pick a play whose subject the story does not touch.",
        },
        {
          role: "user",
          content: `STORY: ${args.storyHeadline}\n\nWHAT THE COVERAGE SAYS (excerpt):\n${args.evidenceHead}\n\nMENU:\n${menu}\n\nPick 0-2 plays. Field rules: seriesId is ONLY the bare code, exactly as written in the menu (e.g. "NY.GDP.MKTP.KD.ZG" or "NGDP_RPCH") — never a description, never inside query. For fred_series set seriesId; for worldbank_indicator and imf_weo set seriesId AND country (ISO code); for usaspending_search and wikipedia_summary set query; for eonet_events set query to the category word; for nasdaq_price and edgar_filings set ticker.`,
        },
      ],
      schema: DataPlayPick,
      schemaName: "data_play_pick",
      ...(args.model === undefined ? {} : { model: args.model }),
      temperature: 0.2,
    });
  } catch (err: unknown) {
    args.log?.(`datagod: play selection failed (skipping primary data): ${String(err)}`);
    return { block: "", chartMarkdown: "" };
  }
  const blocks: string[] = [];
  let chartMarkdown = "";
  for (const pick of picks.plays) {
    const play = args.plays.find((p) => p.id === pick.id);
    if (play === undefined) {
      args.log?.(`datagod: unknown play "${pick.id}" — skipped`);
      continue;
    }
    const req = play.request(pick);
    if (req === null) {
      args.log?.(`datagod: play "${pick.id}" rejected params ${JSON.stringify(pick)} — skipped`);
      continue;
    }
    try {
      const data = await args.datagod.get(req.path, req.params);
      // One chart per article: the first FRED series a story runs on becomes
      // a reader-facing figure, from the same fetch the evidence uses.
      if (chartMarkdown === "" && pick.id === "fred_series" && pick.seriesId !== undefined) {
        const obs = (data as { observations?: { date: string; value: string }[] }).observations;
        const url = Array.isArray(obs) ? fredChartUrl(pick.seriesId, obs) : null;
        if (url !== null) {
          const title = FRED_TITLES[pick.seriesId] ?? pick.seriesId;
          chartMarkdown = `\n\n![${title}](${url})\n\n*${title}. Source: Federal Reserve Economic Data (FRED).*`;
          args.recordArtifact?.("datagod:chart", `${pick.seriesId}\n${url}`);
        }
      }
      const raw = JSON.stringify(data).slice(0, 20_000);
      const parts = await extractEvidence({
        llm: args.llm,
        topic: args.storyHeadline,
        page: { url: req.path, title: `PRIMARY DATA ${play.id}`, content: raw },
        chunkChars: 20_000,
        maxChunksPerPage: 1,
        ...(args.log === undefined ? {} : { log: args.log }),
      });
      if (parts.length === 0) {
        args.log?.(`datagod: play "${pick.id}" returned nothing relevant — dropped`);
        continue;
      }
      blocks.push(
        play.evidenceLabel !== undefined
          ? `${play.evidenceLabel} [${play.id}]:\n${parts.join("\n")}`
          : `PRIMARY DATA (${play.id} — authoritative source; PREFER these figures over any outlet re-tell):\n${parts.join("\n")}`,
      );
      args.recordArtifact?.(`datagod:${play.id}`, `${req.path} ${JSON.stringify(req.params)}\n${parts.join("\n")}`);
    } catch (err: unknown) {
      args.log?.(`datagod: play "${pick.id}" fetch failed (non-blocking): ${String(err)}`);
    }
  }
  return { block: blocks.join("\n\n"), chartMarkdown };
}

/** Article length should track how much was actually reported, not a flat cap
 *  (operator, 2026-07-28). Base target 700 words for a floored story (the
 *  3-source minimum — raised from 500 on 2026-08-27: the archive's median ran
 *  533 words, thin against the depth ad reviewers and the 2026 spam updates
 *  reward); +100 per surviving source beyond that; a bonus for a genuinely
 *  large evidence corpus. Clamped to `maxCap` so a padding model can't run
 *  away. This is the ONE governor on length — the 300-word floor in the
 *  contract stays. */
export function evidenceWordCap(sourceCount: number, evidenceChars: number, maxCap: number): number {
  const bySources = 700 + 100 * Math.max(0, sourceCount - 3);
  const byEvidence = Math.min(350, Math.max(0, Math.round((evidenceChars - 7000) / 45)));
  return Math.max(700, Math.min(maxCap, bySources + byEvidence));
}

/** Google truncates a result title around here; a headline past it is cut
 *  mid-phrase in the one place most readers meet this paper. */
export const SERP_TITLE_CHARS = 70;

/** Title case capitalises these, but they name nothing — so a capitalised
 *  token here is not a claim about the world. Every OTHER capitalised word in
 *  a proposed headline has to already be in the column. */
const HEADLINE_STOPWORDS = new Set(
  ("a an the and but or nor for yet so of in on at to from with without by as is are was were be been " +
    "has have had do does did will would can could should may might must not no now new still just even " +
    "this that these those it its his her their our your my what why how when where who whom which whose " +
    "after before over under against about into out up down off between during through than then there here " +
    "more most less least all any some each every both few many much other another same such only own too very " +
    "if because while although though unless until since despite amid across beyond within toward towards")
    .split(" "),
);

const norm = (s: string): string =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9]+/g, " ").trim();

/** The column's people, places and institutions — every capitalised word that
 *  isn't a stopword.
 *
 *  Deliberately permissive about sentence-initial words: skipping them looks
 *  tidier but loses a name the column only ever opens a sentence with
 *  ("Brussels blinked."), and the two failure modes are not symmetrical. A
 *  false positive here waves through a slightly weaker headline; a false
 *  negative rejects a good one and reinstates another paper's headline, which
 *  is the thing this whole mechanism exists to stop. */
function properNounsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of String(text).split(/[^A-Za-z0-9'’-]+/)) {
    const bare = t.replace(/[^A-Za-z]/g, "");
    if (bare.length >= 3 && /^[A-Z]/.test(bare) && !HEADLINE_STOPWORDS.has(bare.toLowerCase())) {
      out.add(bare.toLowerCase());
    }
  }
  return out;
}

/** Everything a headline must satisfy before it may replace the verbatim one.
 *
 *  The old guarantee was structural: copy an outlet's headline and it cannot
 *  assert anything the reporting didn't. The guarantee here is the same, made
 *  by inspection instead — a headline may only use names, numbers and
 *  quotations that are already in the column (whose own facts the evidence
 *  contract and fact-check audit already govern). Judgement, verbs and framing
 *  are the columnist's and are deliberately unconstrained; that is the part
 *  that makes the headline ours.
 *
 *  Returns the list of failures — empty means the headline is publishable. */
export function validateHeadline(
  candidate: string,
  args: { body: string; sourceHeadline: string; personaName: string; maxChars: number },
): string[] {
  const failures: string[] = [];
  const h = candidate.trim();
  const hay = norm(`${args.body} ${args.sourceHeadline}`);
  const hayDigits = hay.replace(/[^0-9]/g, " ");
  // Names are matched with apostrophes and hyphens removed on BOTH sides,
  // because a name token is compared letters-only. Without it "the
  // Commission's climbdown" normalises to "commission s" and "Mette-Marit"
  // to "mette marit", while the headline tokens reduce to "Commissions" and
  // "MetteMarits" — good headlines rejected for punctuation, each costing a
  // fallback to the wire headline. (The live desk did exactly this to
  // Mette-Marit on 2026-08-28.)
  const hayNames = norm(`${args.body} ${args.sourceHeadline}`.replace(/['’-]/g, ""));

  if (h.length < 25) failures.push(`too short: ${h.length} chars (floor 25)`);
  if (h.length > args.maxChars) failures.push(`too long: ${h.length} chars (cap ${args.maxChars})`);
  // No English gate here on purpose. isEnglishHeadline exists to keep a
  // Spanish or Portuguese FEED headline off an English front page, and it
  // decides by counting function words — so it reads a punchy headline with
  // none ("Brussels blinked, Beijing collected winnings") as foreign. This
  // headline was written from an English column by an English-language
  // columnist, so the risk it guards cannot arise, and applying it here would
  // reject exactly the terse headlines worth having.
  if (stripFurniture(h) !== h) failures.push("opens with editorial furniture we have not earned");
  if (norm(h).includes(norm(args.personaName))) failures.push("names the columnist");

  // A number in a headline is always a claim.
  for (const m of h.match(/\d[\d,.]*/g) ?? []) {
    const digits = m.replace(/[^0-9]/g, "");
    if (digits !== "" && !hayDigits.includes(digits)) failures.push(`number not in the column: ${m}`);
  }

  // A capitalised word that is not a stopword is a name, place or institution.
  const words = h.split(/[^A-Za-z0-9'’.-]+/).filter((w) => w !== "");
  words.slice(1).forEach((w) => {
    const bare = w.replace(/[^A-Za-z]/g, "");
    if (bare.length < 3 || !/^[A-Z]/.test(bare)) return;
    if (HEADLINE_STOPWORDS.has(bare.toLowerCase())) return;
    if (!hayNames.includes(norm(bare))) failures.push(`name not in the column: ${bare}`);
  });

  // A quotation is the one thing a reader takes as verbatim.
  for (const m of h.matchAll(/["“']([^"”']{4,})["”']/g)) {
    if (!hay.includes(norm(m[1] ?? ""))) failures.push(`quotation not in the column: "${m[1]}"`);
  }

  // If it merely echoes the wire headline, nothing was gained by writing it.
  const nh = norm(h);
  const ns = norm(args.sourceHeadline);
  if (nh === ns || nh.includes(ns) || ns.includes(nh)) failures.push("echoes the wire headline");

  // A headline has to say WHAT HAPPENED, not only what the columnist thinks of
  // it. Asked for "the column's argument", the model returns floating verdicts
  // — "Private power needs the state to manage systemic digital risk" — that
  // name nobody and could sit on any story (first live sample, 2026-08-28).
  // Requiring one of the column's own proper nouns is the mechanical form of
  // "a reader must be able to tell which story this is".
  const named = properNounsOf(args.body);
  const carries = h
    .split(/[^A-Za-z0-9'’-]+/)
    .some((w) => named.has(w.replace(/[^A-Za-z]/g, "").toLowerCase()));
  if (named.size > 0 && !carries) failures.push("names nobody and nothing from the column");

  if (/\.$/.test(h)) failures.push("ends in a full stop");

  return failures;
}

// English function words that appear in essentially every English headline vs
// markers of the languages the site: feeds actually supply (es/pt/fr/de/it/tr).
// "a"/"en"/"no" are deliberately in NEITHER set — they are words in both camps.
const ENGLISH_WORDS =
  /\b(the|of|to|in|on|for|as|at|by|with|from|after|amid|over|under|against|and|or|but|not|is|are|was|were|will|would|has|have|had|says|said|new|its|his|her|their|this|that|who|what|why|how|more|than|out|up|down|off|about|into)\b/gi;
const FOREIGN_WORDS =
  /\b(el|la|los|las|un|una|del|de|que|por|para|con|se|es|son|está|más|y|o|ao|da|do|dos|das|em|um|uma|não|são|le|les|des|du|au|aux|dans|est|et|une|der|die|das|und|ist|für|mit|von|zu|im|il|di|che|per|dei|della|nel|ve|bir|bu|için|ile)\b/gi;

/** Is this headline written in English?
 *
 *  Needed because the per-paper site: feeds supply stories whose every
 *  headline is Spanish or Portuguese, and six of them published verbatim as
 *  titles on an English-language front page (2026-08-14/16). The columnists
 *  write their COLUMNS in English regardless — only the title leaks.
 *
 *  ponytail: stopword counting, not language ID. A headline with no function
 *  words in either set reads as not-English, which can drop a rare
 *  all-proper-noun English headline — acceptable, because the gate sees every
 *  headline in the cluster, and a cluster with no survivor now falls back to
 *  translateHeadline rather than dropping the story. */
export function isEnglishHeadline(headline: string): boolean {
  // Non-Latin scripts are never English headlines.
  if (/[Ѐ-ӿ֐-׿؀-ۿ぀-ヿ一-鿿가-힯]/.test(headline)) {
    return false;
  }
  const english = (headline.match(ENGLISH_WORDS) ?? []).length;
  const foreign = (headline.match(FOREIGN_WORDS) ?? []).length;
  return english >= 1 && english > foreign;
}

/** Longest headline in the SERP limit, chosen from what real outlets printed.
 *
 *  Since 2026-08-28 this is the FALLBACK, not the title: `composeHeadline`
 *  writes the column's own headline and falls back here when the result cannot
 *  be verified against the column. The rule below was written for a desk that
 *  retold the news; the desk now files signed op-eds, and printing someone
 *  else's headline over an original argument was both a duplicate-content
 *  signal and a misattribution. The property it protected — the title asserts
 *  nothing the reporting didn't — is now enforced by `validateHeadline`.
 *
 *  The desk never invents a headline — it prints the trending one verbatim, so
 *  the title matches what the sources actually said. But a story arrives with
 *  several real headlines (the lead outlet's plus every outlet in the coverage
 *  cluster), and taking the lead one unexamined put 592 of 1,111 titles past
 *  70 characters, where Google truncates them mid-phrase.
 *
 *  So: still verbatim, just chosen. Among headlines that fit, take the LONGEST
 *  — the most information that will actually be shown. If none fit, take the
 *  shortest of the rest and let it truncate as little as possible. Candidates
 *  that were themselves cut off by the feed ("…") are never titles.
 */
/** Another outlet's editorial furniture, which is a claim about THEIR product
 *  and false about ours: "Exclusive:" says we broke a story we did not,
 *  "Live updates:" and "Watch:"/"Photos:" promise a live page, a video or a
 *  gallery that this column is not (AdSense spam policy calls that misleading
 *  functionality), and a trailing "— Reuters" brands our page as theirs.
 *
 *  Deliberately NOT stripped: attributive qualifiers — "Report:", "Sources:",
 *  "Study:", "Poll:", "Official:". Those describe the CLAIM's provenance, and
 *  dropping one turns "Report: Iran enriched uranium" into an assertion the
 *  reporting never made. Format furniture goes; epistemics stay. */
const LEADING_FURNITURE =
  /^\s*(?:exclusive|breaking(?:\s+news)?|just\s+in|live(?:\s+updates?)?|updated?|developing|watch|video|photos?|in\s+pictures|listen|podcast|analysis|opinion|editorial|explainer|explained|first\s+on\s+\w+)\s*[:|—–-]\s*/i;
const TRAILING_OUTLET = /\s*[|—–-]\s*(?:reuters|ap|the\s+ap|afp|bbc(?:\s+news)?|cnn|cnbc|the\s+guardian|npr|axios|politico|the\s+hill)\s*$/i;

/** Strip borrowed furniture, repeatedly — feeds stack it ("Exclusive: Watch: …"). */
export function stripFurniture(headline: string): string {
  let h = headline.trim();
  for (let i = 0; i < 3 && LEADING_FURNITURE.test(h); i += 1) h = h.replace(LEADING_FURNITURE, "");
  return h.replace(TRAILING_OUTLET, "").trim();
}

export function pickHeadline(story: TrendingStory, maxChars: number): string | null {
  const candidates = [story.headline, ...story.coverage.map((c) => c.headline)]
    .map((h) => stripFurniture(h))
    .filter((h) => h.length >= 25 && !/[…]|\.\.\.$/.test(h))
    // The paper prints in English, so the VERBATIM title must be an English
    // headline. A story whose entire cluster is non-English returns null and
    // the desk falls back to translateHeadline — a validated translation of
    // the whole cluster — before giving up on the story.
    .filter(isEnglishHeadline);
  if (candidates.length === 0) {
    const fallback = stripFurniture(story.headline);
    return isEnglishHeadline(fallback) ? fallback : null;
  }
  const fits = candidates.filter((h) => h.length <= maxChars);
  const pool = fits.length > 0 ? fits : candidates;
  // Ties broken alphabetically so the choice never depends on feed ordering.
  return [...pool].sort((a, b) =>
    fits.length > 0
      ? b.length - a.length || (a < b ? -1 : 1)
      : a.length - b.length || (a < b ? -1 : 1),
  )[0];
}

/** The column's own headline, written from the column.
 *
 *  The desk already demands that every CHAPTER heading inside a column be
 *  original and drawn from what that chapter says; this applies the same rule
 *  to the one heading readers actually see. The wire headline is passed in as
 *  context to argue against, never to copy — `validateHeadline` rejects an
 *  echo of it, and rejects any name, number or quotation the column does not
 *  contain.
 *
 *  Returns null when nothing survived validation, and the caller keeps the
 *  verbatim headline: the worst case of this whole mechanism is the behaviour
 *  the paper had before it. */
export async function composeHeadline(args: {
  llm: LlmClient;
  persona: PersonaProfile;
  body: string;
  sourceHeadline: string;
  maxChars: number;
  maxAttempts: number;
  log?: (line: string) => void;
}): Promise<string | null> {
  const system =
    `You write the headline for a signed opinion column in a daily paper.\n\n` +
    `It must do TWO things at once: say what happened, and land the column's judgement of it. A headline that carries only the judgement ("Private power needs the state to manage risk") is useless — the reader cannot tell which story it is. Name the people, institutions or places at the centre of it.\n\nHARD RULES:\n` +
    `- Aim for 55-65 characters and never exceed ${args.maxChars}.\n` +
    `- Name at least one person, institution or place that the column names, spelled and capitalised exactly as the column spells it.\n` +
    `- Use ONLY names, places, organisations, numbers and quotations that appear in the column. Introduce nothing new — no figure, no name, no statistic.\n` +
    `- Do not reuse or lightly reword the wire headline you are shown. It is what other outlets called the news; your headline is what this columnist says about it.\n` +
    `- No label prefixes ("Opinion:", "Analysis:", "Exclusive:", "Watch:"), no colon-prefixed section tags, and never the columnist's name.\n` +
    `- No clickbait ("You won't believe", "Here's why"), and no full stop at the end.\n\n` +
    `GOOD (names the actors, and takes a side): "Brussels blinked, and Beijing collected the winnings"\n` +
    `BAD (a verdict about nothing in particular): "Trade policy should not reward coercion"`;

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `COLUMNIST: ${args.persona.name}\n\nWHAT THE WIRES CALLED IT (context only — do NOT reuse):\n${args.sourceHeadline}\n\n` +
        `THE COLUMN:\n${args.body.slice(0, 6000)}\n\nWrite the headline.`,
    },
  ];

  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    try {
      const out = await args.llm.completeStructured({
        messages,
        schema: z.object({ headline: z.string().min(20).max(160) }),
        schemaName: "column_headline",
        temperature: 0.4,
      });
      const candidate = stripFurniture(out.headline);
      const failures = validateHeadline(candidate, {
        body: args.body,
        sourceHeadline: args.sourceHeadline,
        personaName: args.persona.name,
        maxChars: args.maxChars,
      });
      if (failures.length === 0) return candidate;
      args.log?.(`news-desk: headline attempt ${attempt} rejected — ${failures.join("; ")}`);
      // Revise, don't regenerate — same shape as the column's contract retry.
      messages.push({ role: "assistant", content: out.headline });
      messages.push({
        role: "user",
        content: `That headline fails: ${failures.join("; ")}. Fix every point and write one headline.`,
      });
    } catch (err: unknown) {
      args.log?.(`news-desk: headline attempt ${attempt} failed: ${String(err)}`);
    }
  }
  return null;
}

/** An English headline translated from a foreign-only cluster — the fallback
 *  `pickHeadline` cannot supply when no outlet wrote one in English.
 *
 *  Foreign-covered news is still news (operator, 2026-08-30): the desk used
 *  to drop a fully composed, audited column at this point — 578 drops in 14
 *  days of run logs. The WHOLE cluster goes into the prompt (every outlet's
 *  headline, every language — cross-language corroboration), and the output
 *  is held to the same standard as a composed headline: `validateHeadline`
 *  against the column, which is the paper's ground truth for names, numbers
 *  and spelling. A translation that asserts anything the column does not
 *  carry is revised once, then abandoned — null, and the caller skips the
 *  story, so nothing unvalidated ever prints. */
export async function translateHeadline(args: {
  llm: LlmClient;
  story: TrendingStory;
  body: string;
  personaName: string;
  maxChars: number;
  maxAttempts: number;
  log?: (line: string) => void;
}): Promise<string | null> {
  const wires = [
    ...new Set(
      [
        `${args.story.leadOutlet}: ${stripFurniture(args.story.headline)}`,
        ...args.story.coverage.map((c) => `${c.outlet}: ${stripFurniture(c.headline)}`),
      ].filter((l) => l.split(": ").slice(1).join(": ").length >= 10),
    ),
  ].slice(0, 8);
  const system =
    `You translate news headlines. The world's press covered ONE story; their headlines are listed below in their original languages. Write the single ENGLISH headline this paper prints for that story.\n\nHARD RULES:\n` +
    `- A faithful, natural English news headline: report what the wires collectively report. No opinion of your own, no additions, no interpretation.\n` +
    `- Every name, place, organisation and number must appear EXACTLY as THE COLUMN below spells it — the column is this paper's ground truth, and foreign spellings often differ from it. Assert nothing the column does not contain.\n` +
    `- Aim for 55-65 characters and never exceed ${args.maxChars}.\n` +
    `- No label prefixes ("Exclusive:", "Watch:", "Live:"), no clickbait, no full stop at the end.`;
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `THE WIRES' HEADLINES:\n${wires.map((w, i) => `${i + 1}. ${w}`).join("\n")}\n\n` +
        `THE COLUMN (ground truth for names, numbers and spelling):\n${args.body.slice(0, 6000)}\n\nWrite the English headline.`,
    },
  ];

  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    try {
      const out = await args.llm.completeStructured({
        messages,
        schema: z.object({ headline: z.string().min(20).max(160) }),
        schemaName: "wire_headline_translation",
        temperature: 0.3,
      });
      const candidate = stripFurniture(out.headline);
      const failures = isEnglishHeadline(candidate)
        ? validateHeadline(candidate, {
            body: args.body,
            sourceHeadline: args.story.headline,
            personaName: args.personaName,
            maxChars: args.maxChars,
          })
        : ["not written in English"];
      if (failures.length === 0) return candidate;
      args.log?.(`news-desk: headline translation attempt ${attempt} rejected — ${failures.join("; ")}`);
      // Revise, don't regenerate — same shape as composeHeadline's retry.
      messages.push({ role: "assistant", content: out.headline });
      messages.push({
        role: "user",
        content: `That headline fails: ${failures.join("; ")}. Fix every point and write one headline.`,
      });
    } catch (err: unknown) {
      args.log?.(`news-desk: headline translation attempt ${attempt} failed: ${String(err)}`);
    }
  }
  return null;
}

/** The shipped coverage channel: Google News, US edition, last week. */
const defaultCoverage = (headline: string): Promise<Coverage[]> =>
  fetchCoverage({ headline, edition: GN_US, limit: 12 });

export function createNewsDesk(opts: {
  llm: LlmClient;
  search: SearchClient;
  embedder?: Embedder;
  feeds: readonly OutletFeed[];
  persona: PersonaProfile;
  /** One take per story (operator, 2026-07-24): the persona's fused column
   *  (retell + take) IS the article, titled with the source-optimized trending
   *  headline verbatim (never model-invented). wordCap is the MAX ceiling; the
   *  actual per-story cap scales with evidence richness (evidenceWordCap). */
  authorVersions?: { wordCap: number };
  brand: BrandProfile;
  sink: Sink;
  /** Keyed SearXNG proxy for the google-images lead-photo fallback. Absent →
   *  source og:image only; a story with no usable source photo runs imageless. */
  imageSearch?: ImageSearchConfig;
  knobs: NewsDeskKnobs;
  /** Who is covering a story, for the source hunt. Defaults to Google News
   *  (sources/google-news.ts fetchCoverage). Injected in checks, and the seam
   *  for swapping in another vetted-publisher index later. */
  coverageImpl?: (headline: string) => Promise<Coverage[]>;
  coveredTopics?: () => Promise<CoveredTopic[]>;
  /** Called when a trending story matches one the paper has already run.
   *
   *  Nearly a third of all runs used to end here having thrown the whole cycle
   *  away — the desk found a live story, recognised it, and discarded the
   *  work. A story that keeps trending after publication is the definition of
   *  developing, so the host is handed the match (which article, and what the
   *  cluster is saying NOW) and can file an update against it.
   *
   *  Best-effort and non-blocking by contract: the desk logs a failure and
   *  carries on to the next story, exactly as it did when it only skipped. */
  onCovered?: (developing: {
    headline: string;
    slug: string;
    coveredTitle: string;
    score: number;
    coverage: readonly { headline: string; outlet: string }[];
  }) => Promise<void>;
  /** Historical parallels recent columns already ran (a host draws them from
   *  its last N published articles). A proposed candidate whose event names
   *  ANY entry (namesEvent — typography-, case-, and leading-article-
   *  insensitive; never raw includes) is skipped BEFORE encyclopedia
   *  verification, so a just-used parallel is never repeated and never costs
   *  a fetch. Absent/empty → today's behavior, prompts byte-identical. */
  recentParallels?: readonly string[];
  /** URLs of images already used by published articles — the desk skips a
   *  source photo that matches so related stories don't share an image. */
  usedImages?: () => Promise<readonly string[]>;
  blockedHosts?: readonly string[]; // default DEFAULT_BLOCKED_HOSTS
  /** Optional DataGod instance — when present, 0-2 primary-data plays run per
   *  story (see DATA_PLAYS) and their figures join the evidence as
   *  authoritative first-party data. Absent → no behavior change. */
  datagod?: DatagodClient;
  dataPlays?: readonly DataPlay[]; // default DATA_PLAYS
  log?: (line: string) => void;
  recordArtifact?: (label: string, content: string) => void;
  // test seams (defaults are the real implementations):
  trendingImpl?: () => Promise<TrendingStory[]>;
  indexImpl?: () => Promise<OutletItem[]>;
  internalsFactory?: typeof createDefaultInternals;
  parallelFetchImpl?: typeof fetch;
}): { run(): Promise<GeneratedPost> } {
  const { llm, search, feeds, persona, brand, sink, knobs, log, recordArtifact } = opts;
  const blockedHosts = opts.blockedHosts ?? DEFAULT_BLOCKED_HOSTS;

  return {
    async run(): Promise<GeneratedPost> {
      const stack = createResearchStack({ search });
      const facade = stack.asSearchClient();
      const scrape = facade.scrape;
      if (scrape === undefined) {
        throw new Error("news-desk: search client has no scrape() port — full-page evidence scraping is required");
      }
      const matcher = createHeadlineMatcher(opts.embedder === undefined ? {} : { embedder: opts.embedder });
      const fetchTrending =
        opts.trendingImpl ?? ((): Promise<TrendingStory[]> => fetchTrendingStories({ edition: GN_US, limit: knobs.trendingLimit }));
      const buildIndex =
        opts.indexImpl ??
        // concurrency 8: the feed list went from 10 papers to 65 (2026-08-16),
        // and at 4 a cold index build serialised into ~17 rounds of waiting.
        ((): Promise<OutletItem[]> => createNewswire({ feeds, concurrency: 8, timeoutMs: 15_000, log }).buildIndex());

      const stories = await fetchTrending();
      recordArtifact?.(
        "trending",
        stories.map((s) => `${s.rank}. ${s.headline} — ${s.leadOutlet} (${s.coverage.length} covering)`).join("\n"),
      );
      const index = await buildIndex();
      const indexTitles = index.map((i) => i.title);
      const covered = (await opts.coveredTopics?.()) ?? [];
      const coveredTitles = covered.map((c) => c.title);

      for (const story of stories) {
        // Covered-story skip: mechanical ledger match, threshold-gated.
        const coveredHit = await matcher.match(story.headline, coveredTitles, knobs.coveredThreshold);
        if (coveredHit !== null) {
          const hitSlug = covered[coveredHit.index]?.slug ?? "";
          log?.(
            `news-desk: "${story.headline}" already covered ("${coveredTitles[coveredHit.index]}", score ${coveredHit.score.toFixed(2)}) — still trending, filing as developing`,
          );
          if (opts.onCovered !== undefined && hitSlug !== "") {
            try {
              await opts.onCovered({
                headline: story.headline,
                slug: hitSlug,
                coveredTitle: coveredTitles[coveredHit.index],
                score: coveredHit.score,
                coverage: story.coverage,
              });
            } catch (err: unknown) {
              // Never fatal: a story the desk cannot follow up is still a
              // story it has already published.
              log?.(`news-desk: onCovered failed (continuing): ${String(err)}`);
            }
          }
          continue;
        }

        // Resolution: GN headlines never carry real URLs — match every probe
        // (lead + coverage headlines) against ALL outlet indexes, keep the
        // best hit per outlet, drop blocked hosts, rank by score, cap pages.
        const probes = [story.headline, ...story.coverage.map((c) => c.headline)];
        const hits = await matcher.matchAny(probes, indexTitles, knobs.matchThreshold);
        const bestByOutlet = new Map<string, { item: OutletItem; score: number }>();
        for (const hit of hits) {
          const item = index[hit.index];
          const prev = bestByOutlet.get(item.outlet);
          if (prev === undefined || hit.score > prev.score) bestByOutlet.set(item.outlet, { item, score: hit.score });
        }
        const unblocked = [...bestByOutlet.values()].filter(({ item }) => {
          const host = hostOf(item.url);
          const blocked = isBlockedHost(host, blockedHosts);
          if (blocked) log?.(`news-desk: dropped ${item.outlet} (${item.url}) — blocked host`);
          // Feeds are curated, but a feed can still link out to a deny-tier
          // host inside its cluster; the tier applies at every door.
          const denied = provenanceOf(host) === "deny";
          if (denied) log?.(`news-desk: dropped ${item.outlet} (${item.url}) — deny-tier provenance`);
          return !blocked && !denied;
        });
        // Source hunt (operator, 2026-07-25: "make sure we write news for every
        // trending news"): the outlet index is ten shallow RSS windows, so real
        // stories often match 0-2 of them — 61% of all rejections. When the
        // index comes up short, ask the search backend for the story's other
        // coverage and admit pages from hosts we don't already hold. Hunted
        // pages face the same blocklist here and the same content floors
        // downstream; index sources keep priority in the page cap.
        const hunted: { item: OutletItem; score: number }[] = [];
        if (unblocked.length < knobs.minSources) {
          try {
            // ── Discovery: Google News, not an open web search ──────────────
            // GN only indexes publishers admitted to its news index, so its
            // coverage cluster is a vetted outlet list by construction. The old
            // hunt asked a web search engine and admitted whatever hosts came
            // back — that is how a WordPress site calling itself "Telegraph
            // Online" got cited (operator, 2026-08-16). GN item links are JS
            // stubs, so what we take is the HOST and that outlet's own
            // HEADLINE; the URL is resolved below.
            const coverage = await (opts.coverageImpl ?? defaultCoverage)(story.headline);
            const fresh = coverage.filter(
              (c) => provenanceOf(c.host) !== "deny" && !isBlockedHost(c.host, blockedHosts),
            );

            // Pass 1 — free: the outlets' own headlines are extra probes into
            // the index we already hold. Most clusters resolve here with no
            // search call at all.
            const held = new Set(unblocked.map(({ item }) => hostOf(item.url)));
            const extraHits = await matcher.matchAny(
              fresh.map((c) => c.headline),
              indexTitles,
              knobs.matchThreshold,
            );
            for (const hit of extraHits) {
              if (unblocked.length + hunted.length >= knobs.pagesMax) break;
              const item = index[hit.index];
              const host = hostOf(item.url);
              if (held.has(host) || isBlockedHost(host, blockedHosts)) continue;
              if (provenanceOf(host) === "deny") continue;
              held.add(host);
              hunted.push({ item, score: hit.score });
            }

            // Pass 2 — locate a URL on an outlet GN already vetted. Web search
            // is a URL-LOCATOR inside one named host here, never a discoverer
            // of hosts: the query is site-restricted and any result off that
            // host is discarded.
            //
            // BUDGETED, because the first version was not: it searched every
            // outlet in the cluster, so a twelve-outlet story cost twelve
            // search calls — and when the backend degraded and each returned
            // nothing, the loop hammered it hardest at exactly the wrong
            // moment and resolved zero (live, 2026-08-17). Now it stops as
            // soon as it has enough, and gives up early when the backend is
            // plainly not answering.
            const SEARCH_BUDGET = 4;
            const EMPTY_STREAK_LIMIT = 2;
            let spent = 0;
            let emptyStreak = 0;
            for (const c of fresh) {
              if (unblocked.length + hunted.length >= knobs.minSources) break;
              if (unblocked.length + hunted.length >= knobs.pagesMax) break;
              if (spent >= SEARCH_BUDGET) {
                log?.(`news-desk: hunt hit its ${SEARCH_BUDGET}-search budget for "${story.headline}"`);
                break;
              }
              if (emptyStreak >= EMPTY_STREAK_LIMIT) {
                log?.(`news-desk: hunt stopping — ${emptyStreak} site searches in a row returned nothing (backend degraded?)`);
                break;
              }
              if (held.has(c.host)) continue;
              spent += 1;
              const found = await search.search(`site:${c.host} ${c.headline}`, { limit: 3 });
              const onHost = found.find(
                (r) => r.url.startsWith("http") && hostOf(r.url).endsWith(c.host),
              );
              if (onHost === undefined) {
                emptyStreak += 1;
                continue;
              }
              emptyStreak = 0;
              held.add(c.host);
              hunted.push({
                item: { outlet: c.outlet, region: "", title: c.headline, url: onHost.url },
                score: 0,
              });
            }
            log?.(
              `news-desk: "${story.headline}" index gave ${unblocked.length}/${knobs.minSources} — GN coverage named ${coverage.length} outlet(s) (${fresh.length} admissible), resolved ${hunted.length}`,
            );
          } catch (err: unknown) {
            log?.(`news-desk: source hunt failed (best-effort, continuing with the index alone): ${String(err)}`);
          }
        }
        const resolved = [...unblocked.sort((a, b) => b.score - a.score), ...hunted].slice(0, knobs.pagesMax);
        recordArtifact?.(
          `resolution: ${story.headline}`,
          resolved.length === 0
            ? "(no outlet index hit survived)"
            : resolved.map(({ item, score }) => `${item.outlet} [${score.toFixed(2)}]: ${item.title} — ${item.url}`).join("\n"),
        );
        if (resolved.length < knobs.minSources) {
          log?.(
            `news-desk: "${story.headline}" resolved only ${resolved.length}/${knobs.minSources} scrapable sources — next story`,
          );
          continue;
        }

        // Full scrape through the hardened facade (memoized + gated); scrape
        // failures and teaser/paywall stubs drop the outlet, floor named.
        const pages: { outlet: string; title: string; url: string; content: string }[] = [];
        for (const { item } of resolved) {
          let content: string;
          try {
            content = await scrape(item.url);
          } catch (err: unknown) {
            log?.(`news-desk: dropped ${item.outlet} (${item.url}) — scrape failed: ${String(err)}`);
            recordArtifact?.(`scrape: ${item.outlet}`, `${item.url}\nDROPPED — scrape failed: ${String(err)}`);
            continue;
          }
          if (isTeaserContent(content, knobs.minContentChars)) {
            log?.(
              `news-desk: dropped ${item.outlet} (${item.url}) — content-quality floor (teaser/paywall marker or under ${knobs.minContentChars} chars; got ${content.length})`,
            );
            recordArtifact?.(`scrape: ${item.outlet}`, `${item.url}\nDROPPED — content-quality floor (${content.length} chars)`);
            continue;
          }
          // Artifact carries the scraped text itself (capped), not just a
          // length marker — provenance a reader can actually inspect.
          recordArtifact?.(`scrape: ${item.outlet}`, `${item.url}\n${content.length} chars\n${content.slice(0, 20_000)}`);
          pages.push({ outlet: item.outlet, title: item.title, url: item.url, content });
        }
        if (pages.length < knobs.minSources) {
          log?.(
            `news-desk: "${story.headline}" kept ${pages.length}/${knobs.minSources} sources after the scrape floors — next story`,
          );
          continue;
        }

        // Per-outlet chunked evidence extraction; outlets whose every chunk
        // replied NONE drop (they carried nothing about THIS story).
        const contributing: { outlet: string; title: string; url: string; block: string }[] = [];
        for (const page of pages) {
          const parts = await extractEvidence({
            llm,
            topic: story.headline,
            page: { url: page.url, title: page.title, content: page.content },
            chunkChars: knobs.chunkChars,
            maxChunksPerPage: knobs.maxChunksPerPage,
            log,
          });
          if (parts.length === 0) {
            log?.(`news-desk: dropped ${page.outlet} (${page.url}) — no relevant evidence (every chunk NONE)`);
            continue;
          }
          contributing.push({
            outlet: page.outlet,
            title: page.title,
            url: page.url,
            block: `SOURCE ${page.outlet} — ${page.title} (${page.url}):\n${parts.join("\n")}`,
          });
        }
        if (contributing.length < knobs.minSources) {
          log?.(
            `news-desk: "${story.headline}" kept ${contributing.length}/${knobs.minSources} sources after evidence extraction — next story`,
          );
          continue;
        }
        let evidence = contributing.map((c) => c.block).join("\n\n");
        let chartMarkdown = "";
        // Primary data (DataGod): selected per story from the plays menu,
        // best-effort, appended as authoritative first-party evidence.
        if (opts.datagod !== undefined) {
          const primary = await gatherPrimaryData({
            llm,
            datagod: opts.datagod,
            plays: opts.dataPlays ?? DATA_PLAYS,
            storyHeadline: story.headline,
            evidenceHead: evidence.slice(0, 1200),
            ...(opts.log === undefined ? {} : { log: opts.log }),
            ...(recordArtifact === undefined ? {} : { recordArtifact }),
          });
          if (primary.block !== "") evidence = `${evidence}\n\n${primary.block}`;
          chartMarkdown = primary.chartMarkdown;
        }
        recordArtifact?.(
          "evidence",
          `${contributing.map((c) => c.outlet).join(", ")} — ${evidence.length} chars\n${contributing.map((c) => `${c.outlet}: ${c.url}`).join("\n")}`,
        );

        // The retell: EngineInternals over the ONE shared evidence corpus —
        // gatherResearch returns it for every section of the fixed plan.
        const internals = (opts.internalsFactory ?? createDefaultInternals)({
          llm,
          search: facade,
          brand,
          source: {
            async gatherSignal() {
              return { items: [] };
            },
          },
          research: stack,
          gatherResearch: async () => ({ block: evidence }),
          knobs: { sectionSnippets: 0, sectionConcurrency: 1 },
        });

        // Parallels (operator, 2026-07-26: "there are always parallels — every
        // news has a point of view"): a research TOURNAMENT, not a floor.
        // Propose → recent-use filter → research EVERY candidate (the
        // encyclopedia record + live web coverage) → one judge call scores
        // mechanism-level fit on the researched evidence → the best verified
        // candidate runs, and its judged mechanism feeds the column.
        // parallelMinScore no longer gates publication; a weak first field
        // triggers ONE broader re-propose, then the best available wins. The
        // no-parallel phrase survives only as a loudly-logged emergency when
        // not one candidate across both rounds verifies against the record.
        const recent = opts.recentParallels ?? [];
        const dropRecent = (cs: ParallelCandidate[]): ParallelCandidate[] =>
          cs.filter((c) => {
            const used = recent.find((r) => namesEvent(c.event, r));
            if (used === undefined) return true;
            log?.(`parallels: skipped "${c.event}" — just used ("${used}")`);
            return false;
          });
        const researchField = async (
          cs: ParallelCandidate[],
        ): Promise<{ v: VerifiedParallel; webNotes: string }[]> => {
          const out: { v: VerifiedParallel; webNotes: string }[] = [];
          for (const c of cs.slice(0, knobs.parallelCount)) {
            try {
              const v = await verifyParallel({
                candidate: c,
                ...(opts.parallelFetchImpl === undefined ? {} : { fetchImpl: opts.parallelFetchImpl }),
              });
              if (v === null || v.extract.trim() === "") {
                log?.(`parallels: "${c.event}" has no verifiable record — dropped`);
                continue;
              }
              let webNotes = "";
              try {
                const hits = await search.search(`${v.event} history mechanism significance`, { limit: 3 });
                webNotes = hits.map((h) => `${h.title}: ${h.snippet}`).join("\n").slice(0, 900);
              } catch (err: unknown) {
                log?.(`parallels: web research failed for "${v.event}" (record alone will serve): ${String(err)}`);
              }
              out.push({ v, webNotes });
            } catch (err: unknown) {
              log?.(`parallels: research failed for "${c.event}" — dropped: ${String(err)}`);
            }
          }
          return out;
        };
        const JudgeSchema = z.object({
          scores: z.array(
            z.object({ event: z.string(), score: z.number().min(0).max(100), mechanism: z.string().min(12) }),
          ),
        });
        const judgeField = async (
          field: { v: VerifiedParallel; webNotes: string }[],
        ): Promise<{ v: VerifiedParallel; score: number } | null> => {
          if (field.length === 0) return null;
          if (field.length === 1) return { v: field[0].v, score: 100 * field[0].v.score };
          try {
            const judged = await llm.completeStructured({
              messages: [
                {
                  role: "system",
                  content:
                    "You judge which historical precedent best explains a news story at the MECHANISM level — the causal machinery they share, never surface resemblance. Score each candidate 0-100 for how completely its researched record supports reading the story through it, and state that shared mechanism in one sentence a columnist could argue.",
                },
                {
                  role: "user",
                  content: `STORY:\n${story.headline}\n${evidence.slice(0, 1000)}\n\nCANDIDATES:\n${field
                    .map(
                      (f, i) =>
                        `${i + 1}. ${f.v.event} (${f.v.era})\nRECORD: ${f.v.extract.slice(0, 500)}\nWEB: ${f.webNotes || "(none)"}`,
                    )
                    .join("\n\n")}`,
                },
              ],
              schema: JudgeSchema,
              schemaName: "parallel_judge",
              temperature: 0.2,
            });
            let best: { v: VerifiedParallel; score: number; mechanism: string } | null = null;
            for (const sc of judged.scores) {
              const hit = field.find((f) => namesEvent(sc.event, f.v.event) || namesEvent(f.v.event, sc.event));
              if (hit === undefined) continue;
              if (best === null || sc.score > best.score) best = { v: hit.v, score: sc.score, mechanism: sc.mechanism };
            }
            if (best === null) return { v: field[0].v, score: 100 * field[0].v.score };
            // The judged mechanism IS the refined similarity the column argues.
            return { v: { ...best.v, claimedSimilarity: best.mechanism }, score: best.score };
          } catch (err: unknown) {
            log?.(`parallels: judge failed (falling back to record score): ${String(err)}`);
            const byScore = [...field].sort((a, b) => b.v.score - a.v.score);
            return { v: byScore[0].v, score: 100 * byScore[0].v.score };
          }
        };
        const candidates = await proposeParallels({
          llm,
          storySummary: `${story.headline}\n${evidence.slice(0, 1500)}`,
          count: knobs.parallelCount,
        });
        let field = await researchField(dropRecent(candidates));
        let judgedBest = await judgeField(field);
        if (judgedBest === null || judgedBest.score < knobs.parallelMinScore * 100) {
          log?.(
            `parallels: first field ${judgedBest === null ? "empty" : `peaked at ${judgedBest.score.toFixed(0)}`} — one broader re-propose`,
          );
          const avoid = candidates.map((c) => c.event).join("; ");
          const retryCandidates = await proposeParallels({
            llm,
            storySummary: `${story.headline}\n${evidence.slice(0, 1500)}`,
            count: knobs.parallelCount,
            correctiveContext: `Prior candidates scored poorly or failed verification: ${avoid}. Propose DIFFERENT precedents whose causal mechanism matches the story — other eras, other domains.`.slice(0, 1200),
          });
          const field2 = await researchField(dropRecent(retryCandidates));
          field = [...field, ...field2];
          const rejudged = await judgeField(field);
          if (rejudged !== null && (judgedBest === null || rejudged.score >= judgedBest.score)) judgedBest = rejudged;
        }
        const parallel: VerifiedParallel | null = judgedBest === null ? null : judgedBest.v;
        if (parallel === null)
          log?.("parallels: EMERGENCY no-parallel — not one candidate verified across two research rounds");
        recordArtifact?.(
          "parallels",
          [
            ...candidates.map((c) => `candidate: ${c.event} (${c.era}) — ${c.claimedSimilarity}`),
            parallel === null
              ? "selected: EMERGENCY — nothing verified across two rounds"
              : `selected: ${parallel.event} → ${parallel.wikipediaUrl} (judged ${judgedBest === null ? "n/a" : judgedBest.score.toFixed(0)}/100) — ${parallel.claimedSimilarity}`,
          ].join("\n"),
        );

        const outletNames = contributing.map((c) => c.outlet);
        // Structured, not a "## Sources" chapter in the body. The site renders
        // this field for readers, for crawlers that never run JS, and as
        // schema.org `citation`; prose reaches only the first of the three.
        const sources = contributing.map((c) => ({
          title: `${c.outlet}: ${c.title}`,
          url: c.url,
        }));

        // Author-versions format: one complete fused column per columnist,
        // each its own post — same title (the trending headline verbatim),
        // slug suffixed with the author, byline the persona. The audit stays
        // informational and runs per version.
        {
          // Story tags (operator, 2026-07-23): one schema-constrained call per
          // story, shared by all versions. Best-effort like the audit — a tag
          // failure logs loudly and never blocks the run.
          let tags: readonly string[] = [];
          let section = "";
          try {
            const tagged = await llm.completeStructured({
              messages: [
                {
                  role: "system",
                  content:
                    "You tag news stories for a section index. Output 5-10 short lowercase tags (1-3 words each) drawn ONLY from the story. ALWAYS include, when the story supports it: (a) the country or region it concerns (e.g. \"ukraine\", \"middle east\", \"european union\"); (b) every organization or institution named (e.g. \"nato\", \"federal reserve\", \"opec\", \"pentagon\"); (c) every notable person named, as their surname or full name (e.g. \"zelensky\", \"jerome powell\"); and (d) the subject area (e.g. \"tariffs\", \"nuclear program\"). Every tag must be a noun or noun phrase — a place, organization, person, or subject. NEVER a verb phrase or clipped sentence fragment (\"france evacuates\", \"wildfires rage\" are wrong; \"france\", \"wildfires\" are right). Never invent an entity the story does not mention.",
                },
                {
                  role: "user",
                  content: `Story: ${story.headline}\n\nEvidence excerpt:\n${evidence.slice(0, 1200)}\n\nAlso choose the ONE section this story files under, from exactly this list: ${SECTIONS.join(", ")}.`,
                },
              ],
              schema: z.object({ tags: z.array(z.string().min(2).max(28)).min(3).max(10), section: z.enum(SECTIONS) }),
              schemaName: "story_tags",
              temperature: 0,
            });
            tags = [...new Set(tagged.tags.map((t) => t.toLowerCase().trim()).filter((t) => t !== ""))].slice(0, 10);
            section = tagged.section;
            recordArtifact?.("tags", `${section} — ${tags.join(", ")}`);
          } catch (err: unknown) {
            log?.(`news-desk: story tagging failed (best-effort, continuing untagged): ${String(err)}`);
          }

          // Lead image (operator, 2026-07-23): ONE per story, shared by all
          // versions — the outlet's own og:image, else Google Images through
          // the keyed SearXNG proxy (operator, 2026-07-24: "just use searxng
          // google images - not Openverse").
          // Best-effort like tags: a failure logs and leaves the story imageless.
          let lead: LeadImage | null = null;
          try {
            const usedImages = new Set((await opts.usedImages?.()) ?? []);
            lead = await pickLeadImage({
              sourceUrls: contributing.map((c) => c.url),
              query: `${story.headline} ${tags.slice(0, 3).join(" ")}`.trim(),
              usedImages,
              ...(opts.imageSearch === undefined ? {} : { imageSearch: opts.imageSearch }),
            });
            recordArtifact?.("lead-image", lead === null ? "(none found)" : `${lead.source}: ${lead.url}\n${lead.credit}`);
          } catch (err: unknown) {
            log?.(`news-desk: lead-image lookup failed (best-effort, continuing imageless): ${String(err)}`);
          }

          const columnist = persona;
          const authorWordCap = evidenceWordCap(contributing.length, evidence.length, opts.authorVersions?.wordCap ?? 1100);
          const rawBody = await composeAuthorVersion({
            llm,
            persona: columnist,
            storyHeadline: story.headline,
            evidenceBlock: evidence,
            outletNames,
            parallel,
            wordCap: authorWordCap,
            maxAttempts: knobs.analysisAttempts,
            log,
          });
          // The verdict lands without a label. Strip "**The bottom line:**" and
          // its formulaic kin if the model reaches for the tag anyway — the
          // verdict prose after it stays (operator, 2026-07-28: reads canned).
          const stripVerdictLabel = (s: string): string =>
            s.replace(
              /\*\*\s*(?:the\s+)?(?:bottom line|in sum|the upshot|in conclusion|the takeaway)\s*:?\s*\*\*\s*[—–-]?\s*/gi,
              "",
            );
          const body = stripVerdictLabel(rawBody);
          // Pass 6, reintroduced 2026-08-30: the desk shipped columns
          // un-line-edited since the 07-21 cutover, and it read like it.
          const editedBody = await lineEditAuthorVersion({
            llm,
            body,
            contract: {
              outletNames,
              parallelEvent: parallel === null ? null : parallel.event,
              wordCap: authorWordCap,
              writerName: columnist.name,
            },
            log,
          });
          const content = `${stripVerdictLabel(editedBody)}${chartMarkdown}`;
          recordArtifact?.(`author version: ${columnist.name}`, content);
          try {
            const audit = await runFactCheckAudit(content, evidence, {
              llm,
              model: "",
              withRetry: async (_label, fn) => fn(),
              ctx: createRunContext("news-desk-audit"),
              gatherExemplars: () => [],
              fetchPriorTitles: async () => [],
              embedDedupSurvivors: async () => null,
              titleExemplarCount: 0,
              titleCollisionSim: 0,
              titleEmbedSim: 0,
              searchTermsCount: 0,
            });
            recordArtifact?.(`fact-check-audit: ${columnist.name}`, audit);
          } catch (err: unknown) {
            log?.(`news-desk: fact-check audit failed (informational, non-blocking): ${String(err)}`);
          }
          // Claim check — the second job for an open web search now that it no
          // longer discovers sources: does anyone INDEPENDENT report this?
          // Informational like the audit; search silence is not falsehood, and
          // blocking on it would gut the paper on legitimate scoops.
          try {
            const checked = await checkClaims({
              column: content,
              llm,
              search,
              citedHosts: contributing.map((c) => hostOf(c.url)),
              max: 4,
              log,
            });
            if (checked.length > 0) {
              recordArtifact?.(
                `claim-check: ${columnist.name}`,
                checked
                  .map((c) => `${c.corroborated ? "OK  " : "WEAK"} ${c.claim}\n     ${c.corroborating.join(", ") || "(no independent corroboration found)"}`)
                  .join("\n"),
              );
            }
          } catch (err: unknown) {
            log?.(`news-desk: claim check failed (informational, non-blocking): ${String(err)}`);
          }
          // One take per story → the headline alone is the slug, capped at a
          // WORD boundary (a raw 70-char slice shipped ".../criminal-co").
          // `title` is the chosen verbatim headline; `telemetry.topic` below
          // stays the GN headline, because the covered-story ledger is keyed
          // to what the feed said and must keep matching next run.
          const englishWire = pickHeadline(story, SERP_TITLE_CHARS);
          // Foreign-only cluster → translate the wires (operator, 2026-08-30:
          // "if something happened in a foreign country we must definitely
          // translate"). The translation is validated against the column like
          // any printed title; only when THAT also fails does the story drop —
          // previously an unconditional drop that discarded a fully composed
          // column, 578 times in 14 days of run logs.
          const sourceHeadline =
            englishWire ??
            (await translateHeadline({
              llm,
              story,
              body,
              personaName: columnist.name,
              maxChars: SERP_TITLE_CHARS,
              maxAttempts: 2,
              log,
            }));
          if (sourceHeadline === null) {
            log?.(
              `news-desk: "${story.headline}" — no English headline in the cluster and no translation validated — next story`,
            );
            continue;
          }
          if (englishWire === null) {
            log?.(`news-desk: no English wire headline — using validated translation: "${sourceHeadline}"`);
          }
          // The column argues its own thesis, so it gets its own headline; the
          // wire headline stays as the fallback when nothing validates.
          const composed = await composeHeadline({
            llm,
            persona: columnist,
            body,
            sourceHeadline,
            maxChars: SERP_TITLE_CHARS,
            maxAttempts: 2,
            log,
          });
          if (composed === null) log?.(`news-desk: headline unverified — keeping the wire headline`);
          const title = composed ?? sourceHeadline;
          const rawSlug = internals.slugify(title);
          const slug =
            rawSlug.length <= 70 ? rawSlug : rawSlug.slice(0, 70).replace(/-[^-]*$/, "").replace(/-+$/, "");
          const article: GeneratedArticle = {
            title,
            description: dekFrom(body),
            category: "news",
            tags: [...tags],
            keywords: [],
            content,
          };
          // Third arg is telemetry.topic and ONLY that (presets/default.ts) —
          // the title comes from `article`. It must stay the FEED headline:
          // the host keys out/covered.json to it, and next run probes that
          // ledger with raw feed headlines. Passing the chosen title here made
          // every future dedup compare two different alphabets.
          const fin = internals.finalizePost(article, slug, story.headline);
          const post: GeneratedPost = {
            ...fin,
            byline: columnist.name,
            tags,
            sources,
            ...(story.breaking === true ? { breaking: true } : {}),
            ...(section === "" ? {} : { section }),
            ...(lead === null ? {} : { imageUrl: lead.url, imageCredit: lead.credit, imageSource: lead.source }),
            // The parallel this column ran on — a host records it per post
            // and feeds it back as recentParallels so later runs skip it.
            ...(parallel === null ? {} : { telemetry: { ...fin.telemetry, parallel: parallel.event } }),
          };
          await sink.publish(post);
          recordArtifact?.("published", `${post.slug}\n${post.title}\n${post.byline ?? ""}`);
          return post;
        }

      }
      throw new Error(`news-desk: no trending story resolved ≥${knobs.minSources} scrapable sources`);
    },
  };
}
