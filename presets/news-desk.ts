/**
 * presets/news-desk.ts — the spec'd news-desk path. Part 1: neutral personas,
 * the FIXED retell template (the model fills sections, never designs them —
 * the gemma-narrowing rule extended to structure), and the contract-gated
 * Analysis composer. Part 2 (createNewsDesk) orchestrates.
 */
import { DISANALOGY_MARKER, BOTTOM_LINE_MARKER,
  mentionsName, namesEvent, NO_PARALLEL_PHRASE, runFactCheckAudit } from "../gates";
import { createHeadlineMatcher } from "../matching";
import { pickLeadImage } from "../sources/lead-image";
import type { LeadImage } from "../sources/lead-image";
import { proposeParallels, selectParallel, verifyParallel } from "../parallels";
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
import { fetchTrendingStories, GN_US } from "../sources/google-news";
import type { TrendingStory } from "../sources/google-news";
import { createNewswire } from "../sources/newswire";
import type { OutletFeed, OutletItem } from "../sources/newswire";
import { createDefaultInternals } from "./default";


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

/** Three neutral example personas (spec) — method over ideology. */
export const PERSONAS: {
  historian: PersonaProfile;
  realist: PersonaProfile;
  systems: PersonaProfile;
} = {
  historian: {
    name: "The Historian",
    method:
      "Read today's event against the long record. Anchor every judgment in the verified historical parallel and in dated, sourced facts.",
    priors:
      "Structural forces outlast personalities; most 'unprecedented' events have precedents; institutions adapt slower than markets.",
    voice: "Measured, concrete, professorial without jargon. Short sentences when the point lands.",
  },
  realist: {
    name: "The Realist",
    method:
      "Follow incentives and power. Ask who gains, who pays, and what each actor's cheapest next move is — grounded only in the sourced evidence.",
    priors:
      "Stated reasons are rarely operative reasons; capability beats intention; costs are borne by whoever can least avoid them.",
    voice: "Direct, unsentimental, occasionally dry. Never cynical for its own sake.",
  },
  systems: {
    name: "The Systems Thinker",
    method:
      "Trace feedback loops, bottlenecks, and second-order effects visible in the evidence. Name what dampens or amplifies the shock.",
    priors:
      "Tightly coupled systems fail fast; buffers are invisible until they empty; incentives create the topology.",
    voice: "Analytical, diagram-in-prose, plain words for complex mechanisms.",
  },
};

/** Chapter titles that say nothing: newspaper section labels, essay furniture,
 *  or the word we are explicitly retiring ("Analysis — <Name>"). */
const GENERIC_HEADING_RE =
  /^(the\s+)?(analysis|analyses|introduction|intro|conclusion|conclusions|background|context|overview|summary|commentary|opinion|takeaway|takeaways|discussion|body|what\s+happened|the\s+numbers|the\s+facts|reactions?|sources?|final\s+thoughts?)\b/i;

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
  const at = version.indexOf(BOTTOM_LINE_MARKER);
  if (at === -1) failures.push(`missing the "${BOTTOM_LINE_MARKER}" verdict paragraph`);
  else if (version.slice(at + BOTTOM_LINE_MARKER.length).trim().length < 40)
    failures.push("bottom-line verdict too thin (under 40 chars)");
  if (args.parallelEvent !== null) {
    // namesEvent: typography-, case-, and leading-article-insensitive — the
    // exact-includes() false-negative class rejected correct columns twice
    // live on 2026-07-23 ("Smoot–Hawley" en dash; "the Dust Bowl" case).
    if (!namesEvent(version, args.parallelEvent))
      failures.push(`must name the verified parallel ("${args.parallelEvent}")`);
    if (!version.includes(DISANALOGY_MARKER)) failures.push(`missing the "${DISANALOGY_MARKER}" paragraph`);
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
      : `YOUR CENTRAL PARALLEL: "${parallel.event}". VERIFIED BACKGROUND (internal fact-check — never mention Wikipedia or any encyclopedia in your column; if your memory of this history conflicts with the background, THE BACKGROUND WINS — correct your history to it):\n${parallel.extract}\nClaimed similarity: ${parallel.claimedSimilarity}\nName the parallel event in your argument (by its name as given above), and include a paragraph starting exactly with "${DISANALOGY_MARKER}" stating where the parallel does NOT hold.`;

  const system = `You are ${persona.name}, an opinion columnist with a decided worldview, writing your COMPLETE column on today's story: you retell what happened AND argue what it means, fused in one voice — yours. The facts belong to the reporting; the framing, emphasis, and verdict belong to you.\n\nPERSONA: ${persona.name}${persona.bio === undefined ? "" : `\nBiography (you ARE this person — let the background drive your style, word choice, references, and lean; live it, never recite it): ${persona.bio}`}\nMethod: ${persona.method}\nPriors: ${persona.priors}\nVoice: ${persona.voice}`;

  const target = `${Math.round(args.wordCap * 0.7)}-${Math.round(args.wordCap * 0.85)}`;
  const base = `TODAY'S STORY: ${args.storyHeadline}\n\nTHE EVIDENCE (your ONLY source of current facts — quotes verbatim, numbers exact):\n${args.evidenceBlock}\n\n${parallelBlock}\n\nWrite your complete column now. Requirements:\n- Retell the story's essentials through your lens: who did what, the key figures and quotes — attributing the reporting in prose to at least TWO of these outlets by name: ${args.outletNames.join(", ")}\n- Never invent facts beyond the evidence; interpretation is yours, facts are theirs\n- Argue ONE decided position with force; no both-sides hedging, no "time will tell"\n- Close with a paragraph starting exactly: ${BOTTOM_LINE_MARKER} — one committed verdict\n- Break the piece into 2-4 chapters, each opening with a markdown heading ("## ..."). EVERY chapter title must be ORIGINAL and written from what THAT chapter actually says — a specific line a reader could only have written after reading it. NEVER use a generic label ("Analysis", "Context", "Background", "Conclusion", "What happened", "The numbers") and NEVER put your own name in a heading
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
  /** Build the request from validated params. */
  request(params: { seriesId?: string; query?: string; ticker?: string }): {
    path: string;
    params?: Record<string, string | number>;
  } | null;
}

export const FRED_SERIES_WHITELIST = [
  "GDP", "CPIAUCSL", "UNRATE", "FEDFUNDS", "DGS10", "SP500", "DCOILWTICO",
] as const;

export const DATA_PLAYS: readonly DataPlay[] = [
  {
    id: "fred_series",
    useFor:
      "US macroeconomic indicators the story turns on: GDP growth, inflation/CPI (CPIAUCSL), unemployment (UNRATE), Fed interest rates (FEDFUNDS), 10-year Treasury yield (DGS10), S&P 500 (SP500), WTI crude oil price (DCOILWTICO). seriesId MUST be one of the whitelist.",
    request: (p) =>
      p.seriesId !== undefined && (FRED_SERIES_WHITELIST as readonly string[]).includes(p.seriesId)
        ? { path: `/fred/${p.seriesId}`, params: { limit: 6, sort_order: "desc" } }
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
];

const DataPlayPick = z.object({
  plays: z
    .array(
      z.object({
        id: z.string(),
        seriesId: z.string().optional(),
        query: z.string().optional(),
        ticker: z.string().optional(),
      }),
    )
    .max(2),
});

/** Select 0-2 primary-data plays for a story (one narrow schema-constrained
 *  call), fetch them best-effort, and compact each payload into evidence
 *  bullets via the proven chunked extractor. Returns "" when nothing applies
 *  or nothing survives — data plays must never block an article. */
export async function gatherPrimaryData(args: {
  llm: LlmClient;
  datagod: DatagodClient;
  plays: readonly DataPlay[];
  storyHeadline: string;
  evidenceHead: string;
  model?: string;
  log?: (line: string) => void;
  recordArtifact?: (label: string, content: string) => void;
}): Promise<string> {
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
          content: `STORY: ${args.storyHeadline}\n\nWHAT THE COVERAGE SAYS (excerpt):\n${args.evidenceHead}\n\nMENU:\n${menu}\n\nPick 0-2 plays. For fred_series set seriesId (whitelist only); for usaspending_search set query; for nasdaq_price set ticker.`,
        },
      ],
      schema: DataPlayPick,
      schemaName: "data_play_pick",
      ...(args.model === undefined ? {} : { model: args.model }),
      temperature: 0.2,
    });
  } catch (err: unknown) {
    args.log?.(`datagod: play selection failed (skipping primary data): ${String(err)}`);
    return "";
  }
  const blocks: string[] = [];
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
        `PRIMARY DATA (${play.id} — authoritative source; PREFER these figures over any outlet re-tell):\n${parts.join("\n")}`,
      );
      args.recordArtifact?.(`datagod:${play.id}`, `${req.path} ${JSON.stringify(req.params)}\n${parts.join("\n")}`);
    } catch (err: unknown) {
      args.log?.(`datagod: play "${pick.id}" fetch failed (non-blocking): ${String(err)}`);
    }
  }
  return blocks.join("\n\n");
}

export function createNewsDesk(opts: {
  llm: LlmClient;
  search: SearchClient;
  embedder?: Embedder;
  feeds: readonly OutletFeed[];
  persona: PersonaProfile;
  /** Optional additional columnists: when present, EVERY persona in
   *  [persona, ...personas] writes its own contract-gated Analysis column
   *  under the same retell + verified parallel — an op-ed page, one story. */
  personas?: readonly PersonaProfile[];
  /** Author-versions format (operator, 2026-07-23): when set, there is NO
   *  neutral retell — each columnist writes one COMPLETE capped column
   *  (retell + take fused) published as its OWN post whose title is the
   *  source-optimized trending headline verbatim (never model-invented) and
   *  whose slug gets the columnist's first name as suffix. Unset → the
   *  op-ed-page format above (one post: retell + Analysis columns). */
  authorVersions?: { wordCap: number };
  brand: BrandProfile;
  sink: Sink;
  knobs: NewsDeskKnobs;
  coveredTopics?: () => Promise<CoveredTopic[]>;
  /** Historical parallels recent columns already ran (a host draws them from
   *  its last N published articles). A proposed candidate whose event names
   *  ANY entry (namesEvent — typography-, case-, and leading-article-
   *  insensitive; never raw includes) is skipped BEFORE encyclopedia
   *  verification, so a just-used parallel is never repeated and never costs
   *  a fetch. Absent/empty → today's behavior, prompts byte-identical. */
  recentParallels?: readonly string[];
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
        opts.indexImpl ?? ((): Promise<OutletItem[]> => createNewswire({ feeds, concurrency: 4, timeoutMs: 15_000, log }).buildIndex());

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
          log?.(
            `news-desk: "${story.headline}" already covered ("${coveredTitles[coveredHit.index]}", score ${coveredHit.score.toFixed(2)}) — skipping`,
          );
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
          const blocked = isBlockedHost(hostOf(item.url), blockedHosts);
          if (blocked) log?.(`news-desk: dropped ${item.outlet} (${item.url}) — blocked host`);
          return !blocked;
        });
        const resolved = unblocked.sort((a, b) => b.score - a.score).slice(0, knobs.pagesMax);
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
          if (primary !== "") evidence = `${evidence}\n\n${primary}`;
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

        // Parallels: propose (schema-constrained) → recent-use filter →
        // Wikipedia-verify → select. A candidate naming a just-used parallel
        // (opts.recentParallels) drops BEFORE verification — the fetch is
        // never wasted, and the desk that ran "Panic of 1907" last week
        // doesn't run it again this week. Rejection falls through to the next
        // candidate; none surviving takes the legal no-parallel path.
        const candidates = await proposeParallels({
          llm,
          storySummary: `${story.headline}\n${evidence.slice(0, 1500)}`,
          count: knobs.parallelCount,
        });
        const recent = opts.recentParallels ?? [];
        const dropRecent = (cs: ParallelCandidate[]): ParallelCandidate[] =>
          cs.filter((c) => {
            const used = recent.find((r) => namesEvent(c.event, r));
            if (used === undefined) return true;
            log?.(`parallels: skipped "${c.event}" — just used ("${used}")`);
            return false;
          });
        const fresh = dropRecent(candidates);
        let parallel = await selectParallel({
          candidates: fresh,
          minScore: knobs.parallelMinScore,
          ...(opts.parallelFetchImpl === undefined ? {} : { fetchImpl: opts.parallelFetchImpl }),
          log,
        });
        // Memory-vs-record conflict (operator, 2026-07-23): when no candidate
        // survives, regenerate ONCE with the verified record as corrective
        // context instead of settling straight for honest absence. Use the
        // first candidate whose page exists — its extract IS the record that
        // contradicted the model's memory.
        if (parallel === null && fresh.length > 0) {
          let record = "";
          for (const c of fresh) {
            try {
              const v = await verifyParallel({ candidate: c, ...(opts.parallelFetchImpl === undefined ? {} : { fetchImpl: opts.parallelFetchImpl }) });
              if (v !== null && v.extract.trim() !== "") { record = `${v.wikipediaTitle}: ${v.extract}`; break; }
            } catch {
              // record hunt is best-effort; absence path remains below
            }
          }
          if (record !== "") {
            log?.("parallels: no candidate survived — one corrective re-propose with the verified record");
            const retryCandidates = await proposeParallels({
              llm,
              storySummary: `${story.headline}\n${evidence.slice(0, 1500)}`,
              count: knobs.parallelCount,
              correctiveContext: record.slice(0, 1200),
            });
            parallel = await selectParallel({
              candidates: dropRecent(retryCandidates),
              minScore: knobs.parallelMinScore,
              ...(opts.parallelFetchImpl === undefined ? {} : { fetchImpl: opts.parallelFetchImpl }),
              log,
            });
          }
        }
        recordArtifact?.(
          "parallels",
          [
            ...candidates.map((c) => `candidate: ${c.event} (${c.era}) — ${c.claimedSimilarity}`),
            parallel === null
              ? "selected: none survived verification"
              : `selected: ${parallel.event} → ${parallel.wikipediaUrl} (score ${parallel.score.toFixed(2)})`,
          ].join("\n"),
        );

        const columnists: readonly PersonaProfile[] = [persona, ...(opts.personas ?? [])];
        const outletNames = contributing.map((c) => c.outlet);
        const sourceLines = contributing.map((c) => `- ${c.outlet}: [${c.title}](${c.url})`);

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
                    "You tag news stories for a section index. Output 5-10 short lowercase tags (1-3 words each) drawn ONLY from the story. ALWAYS include, when the story supports it: (a) the country or region it concerns (e.g. \"ukraine\", \"middle east\", \"european union\"); (b) every organization or institution named (e.g. \"nato\", \"federal reserve\", \"opec\", \"pentagon\"); (c) every notable person named, as their surname or full name (e.g. \"zelensky\", \"jerome powell\"); and (d) the subject area (e.g. \"tariffs\", \"nuclear program\"). Never invent an entity the story does not mention.",
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
          // versions — the outlet's own og:image, else an Openverse CC search.
          // Best-effort like tags: a failure logs and leaves the story imageless.
          let lead: LeadImage | null = null;
          try {
            lead = await pickLeadImage({
              sourceUrls: contributing.map((c) => c.url),
              query: `${story.headline} ${tags.slice(0, 3).join(" ")}`.trim(),
            });
            recordArtifact?.("lead-image", lead === null ? "(none found)" : `${lead.source}: ${lead.url}\n${lead.credit}`);
          } catch (err: unknown) {
            log?.(`news-desk: lead-image lookup failed (best-effort, continuing imageless): ${String(err)}`);
          }

          let published: GeneratedPost | null = null;
          for (const columnist of columnists) {
            const body = await composeAuthorVersion({
              llm,
              persona: columnist,
              storyHeadline: story.headline,
              evidenceBlock: evidence,
              outletNames,
              parallel,
              wordCap: opts.authorVersions?.wordCap ?? 600,
              maxAttempts: knobs.analysisAttempts,
              log,
            });
            const content = `${body}\n\n## Sources\n${sourceLines.join("\n")}`;
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
            // One take per story → the headline alone is the slug. (When more
            // than one columnist runs the same story, the author disambiguates.)
            const base = internals.slugify(story.headline).slice(0, 70).replace(/-+$/, "");
            const first = columnist.name.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "columnist";
            const slug = columnists.length === 1 ? base : `${base.slice(0, 60).replace(/-+$/, "")}-${first}`;
            const article: GeneratedArticle = {
              title: story.headline,
              description: body.trim().slice(0, 160),
              category: "news",
              tags: [...tags],
              keywords: [],
              content,
            };
            const fin = internals.finalizePost(article, slug, story.headline);
            const post: GeneratedPost = {
              ...fin,
              byline: columnist.name,
              tags,
              ...(section === "" ? {} : { section }),
              ...(lead === null ? {} : { imageUrl: lead.url, imageCredit: lead.credit, imageSource: lead.source }),
              // The parallel this column ran on — a host records it per post
              // and feeds it back as recentParallels so later runs skip it.
              ...(parallel === null ? {} : { telemetry: { ...fin.telemetry, parallel: parallel.event } }),
            };
            await sink.publish(post);
            recordArtifact?.("published", `${post.slug}\n${post.title}\n${post.byline ?? ""}`);
            published = post;
          }
          if (published === null) throw new Error("news-desk: author-versions ran with zero columnists");
          return published;
        }

      }
      throw new Error(`news-desk: no trending story resolved ≥${knobs.minSources} scrapable sources`);
    },
  };
}
