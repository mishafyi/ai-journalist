/**
 * presets/news-desk.ts — the spec'd news-desk path. Part 1: neutral personas,
 * the FIXED retell template (the model fills sections, never designs them —
 * the gemma-narrowing rule extended to structure), and the contract-gated
 * Analysis composer. Part 2 (createNewsDesk) orchestrates.
 */
import { checkAnalysisContract, DISANALOGY_MARKER,
  BOTTOM_LINE_MARKER, NO_PARALLEL_PHRASE, normalizeTypography, runFactCheckAudit } from "../gates";
import { createHeadlineMatcher } from "../matching";
import { proposeParallels, selectParallel, verifyParallel } from "../parallels";
import type { VerifiedParallel } from "../parallels";
import type { GeneratedArticle } from "../pipeline";
import type { Plan } from "../planning";
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

/** The FIXED three-section retell (spec: What happened / The numbers &
 *  reactions / Context). queries stay empty — every section grounds in the
 *  ONE shared evidence corpus the orchestrator supplies via gatherResearch. */
export function buildRetellPlan(storyHeadline: string): Plan {
  return {
    title: storyHeadline,
    angle: "what happened, what the numbers say, and the context a reader needs",
    themeStatement: `${storyHeadline} — the essence of today's coverage, retold with per-outlet attribution`,
    sections: [
      {
        heading: "What happened",
        intent:
          "The event itself: who did what, when, where — attributed per outlet ('X reports…, per Y…'), leading with the newest confirmed developments.",
        queries: [],
      },
      {
        heading: "The numbers and reactions",
        intent:
          "Every concrete figure, quote, and official reaction in the evidence, verbatim where quoted, each attributed to its outlet.",
        queries: [],
      },
      {
        heading: "Context",
        intent:
          "Only the background the evidence itself supplies: what preceded this, what it connects to, what remains unresolved.",
        queries: [],
      },
    ],
  };
}

/** Compose the persona Analysis; accept only what checkAnalysisContract
 *  passes. Failures feed back into the retry prompt; exhausted attempts throw. */
export async function composeAnalysis(args: {
  llm: LlmClient;
  persona: PersonaProfile;
  evidenceBlock: string;
  outletNames: readonly string[];
  parallel: VerifiedParallel | null;
  maxAttempts: number;
  model?: string;
  log?: (line: string) => void;
}): Promise<string> {
  const { persona } = args;
  // Guard: an empty-string event is honest absence, not a parallel — the
  // contract's includes("") is vacuously true, so "" must take the null path.
  const parallel = args.parallel !== null && args.parallel.event.trim() !== "" ? args.parallel : null;
  const parallelBlock =
    parallel === null
      ? `NO parallel survived verification. You MUST include this sentence verbatim: "${NO_PARALLEL_PHRASE}" — then analyze on the evidence alone.`
      : `YOUR CENTRAL PARALLEL: "${parallel.event}". VERIFIED BACKGROUND (internal fact-check — never mention Wikipedia or any encyclopedia in your column; if your memory of this history conflicts with the background, THE BACKGROUND WINS — correct your history to it):\n${parallel.extract}\nClaimed similarity: ${parallel.claimedSimilarity}\nName the parallel event in your argument, and include a paragraph starting exactly with "${DISANALOGY_MARKER}" stating where the parallel does NOT hold.`;

  // Op-ed direction (operator, 2026-07-23): a decided position argued from the
  // persona's historical knowledge. The retell above the column carries ALL
  // news sourcing — the column cites no outlets and hedges nothing.
  const system = `You are ${persona.name}, an opinion columnist with a decided worldview. You write the op-ed Analysis under a news story. You have ALREADY made up your mind: take ONE clear position and argue it with conviction — never give a balanced both-sides view, never hedge with "time will tell". Your material is HISTORY AS YOU KNOW IT — patterns, precedents, and consequences of moments like this one — measured against the events in the story. Do NOT cite or name news outlets; the reporting above carries the sourcing. Never invent quotes or specific facts about the current events beyond the story summary.\n\nPERSONA: ${persona.name}${persona.bio === undefined ? "" : `\nBiography (you ARE this person — let the background drive your style, word choice, references, and lean): ${persona.bio}`}\nMethod: ${persona.method}\nPriors: ${persona.priors}\nVoice: ${persona.voice}`;

  const base = `THE STORY (as reported above your column — your factual ground for current events):\n${args.evidenceBlock}\n\n${parallelBlock}\n\nWrite the op-ed Analysis now. Requirements:\n- Open with exactly: ## Analysis — ${persona.name}\n- Argue ONE decided position; open strong, no throat-clearing\n- Draw on history you know beyond the story; anchor on the verified parallel when one is given\n- Do NOT name any news outlet (not: ${args.outletNames.join(", ")})\n- Close with a paragraph starting exactly: ${BOTTOM_LINE_MARKER} — one committed verdict on what this means or what happens next\n- 250-450 words, unmistakably in the persona's voice.`;

  let lastFailures: string[] = [];
  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? base
        : `${base}\n\nYour previous attempt failed the contract:\n${lastFailures.map((f) => `- ${f}`).join("\n")}\nFix every failure and rewrite the full section.`;
    const analysis = await args.llm.complete({
      system,
      prompt,
      temperature: 0.4,
      ...(args.model === undefined ? {} : { model: args.model }),
    });
    const verdict = checkAnalysisContract(analysis, {
      personaName: persona.name,
      outletNames: args.outletNames,
      parallelEvent: parallel === null ? null : parallel.event,
    });
    if (verdict.ok) return analysis;
    lastFailures = verdict.failures;
    args.log?.(`analysis attempt ${attempt}/${args.maxAttempts} failed contract: ${verdict.failures.join(" | ")}`);
  }
  throw new Error(`analysis failed the contract after ${args.maxAttempts} attempts: ${lastFailures.join(" | ")}`);
}

/** Mechanical contract for a fused author version (operator, 2026-07-23:
 *  "whole retelling AND analysis from author perspective, shorter, capped").
 *  The piece retells the reporting (so outlet attribution is REQUIRED here,
 *  unlike the columns contract where the neutral retell carried sourcing)
 *  and argues the author's take (bottom line + verified-parallel rules). */
export function checkAuthorVersionContract(
  version: string,
  args: { outletNames: readonly string[]; parallelEvent: string | null; wordCap: number },
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const words = version.trim().split(/\s+/).length;
  if (words < 300) failures.push(`too short: ${words} words (floor 300)`);
  if (words > args.wordCap) failures.push(`over the cap: ${words} words (cap ${args.wordCap})`);
  const mentioned = args.outletNames.filter((o) => version.includes(o));
  if (mentioned.length < 2)
    failures.push(
      `must attribute the reporting to at least 2 outlets by name (found ${mentioned.length === 0 ? "none" : mentioned.join(", ")})`,
    );
  const at = version.indexOf(BOTTOM_LINE_MARKER);
  if (at === -1) failures.push(`missing the "${BOTTOM_LINE_MARKER}" verdict paragraph`);
  else if (version.slice(at + BOTTOM_LINE_MARKER.length).trim().length < 40)
    failures.push("bottom-line verdict too thin (under 40 chars)");
  if (args.parallelEvent !== null) {
    // Typography-insensitive: the verified record spells "Smoot–Hawley" with
    // an en dash; a column copying that spelling names the parallel (live
    // 2026-07-23 failure — exact includes() rejected correct columns).
    if (!normalizeTypography(version).includes(normalizeTypography(args.parallelEvent)))
      failures.push(`must name the verified parallel ("${args.parallelEvent}")`);
    if (!version.includes(DISANALOGY_MARKER)) failures.push(`missing the "${DISANALOGY_MARKER}" paragraph`);
  } else if (!version.includes(NO_PARALLEL_PHRASE)) {
    failures.push(`no verified parallel: must include "${NO_PARALLEL_PHRASE}" verbatim`);
  }
  if (/wikipedia|encyclopedia/i.test(version)) failures.push("must not mention Wikipedia/encyclopedias (verification is internal)");
  if (/^#{1,4} /m.test(version)) failures.push("no headings — running prose only (title and Sources are added mechanically)");
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
  const base = `TODAY'S STORY: ${args.storyHeadline}\n\nTHE EVIDENCE (your ONLY source of current facts — quotes verbatim, numbers exact):\n${args.evidenceBlock}\n\n${parallelBlock}\n\nWrite your complete column now. Requirements:\n- Retell the story's essentials through your lens: who did what, the key figures and quotes — attributing the reporting in prose to at least TWO of these outlets by name: ${args.outletNames.join(", ")}\n- Never invent facts beyond the evidence; interpretation is yours, facts are theirs\n- Argue ONE decided position; no both-sides hedging, no "time will tell"\n- Close with a paragraph starting exactly: ${BOTTOM_LINE_MARKER} — one committed verdict\n- Running prose paragraphs ONLY — no headline, no headings, no lists (the headline and Sources are added outside your text)\n- ${target} words, hard cap ${args.wordCap} — unmistakably in your voice.`;

  let lastFailures: string[] = [];
  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? base
        : `${base}\n\nYour previous attempt failed the contract:\n${lastFailures.map((f) => `- ${f}`).join("\n")}\nFix every failure and rewrite the full column.`;
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
    });
    if (verdict.ok) return version;
    lastFailures = verdict.failures;
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
          recordArtifact?.(`scrape: ${item.outlet}`, `${item.url}\n${content.length} chars`);
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

        // Parallels: propose (schema-constrained) → Wikipedia-verify → select.
        const candidates = await proposeParallels({
          llm,
          storySummary: `${story.headline}\n${evidence.slice(0, 1500)}`,
          count: knobs.parallelCount,
        });
        let parallel = await selectParallel({
          candidates,
          minScore: knobs.parallelMinScore,
          ...(opts.parallelFetchImpl === undefined ? {} : { fetchImpl: opts.parallelFetchImpl }),
          log,
        });
        // Memory-vs-record conflict (operator, 2026-07-23): when no candidate
        // survives, regenerate ONCE with the verified record as corrective
        // context instead of settling straight for honest absence. Use the
        // first candidate whose page exists — its extract IS the record that
        // contradicted the model's memory.
        if (parallel === null && candidates.length > 0) {
          let record = "";
          for (const c of candidates) {
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
              candidates: retryCandidates,
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
        if (opts.authorVersions !== undefined) {
          let published: GeneratedPost | null = null;
          for (const columnist of columnists) {
            const body = await composeAuthorVersion({
              llm,
              persona: columnist,
              storyHeadline: story.headline,
              evidenceBlock: evidence,
              outletNames,
              parallel,
              wordCap: opts.authorVersions.wordCap,
              maxAttempts: knobs.analysisAttempts,
              log,
            });
            const marker = columnist.bio === undefined ? "" : `*AI columnist persona — ${columnist.bio}*\n\n`;
            const content = `${marker}${body}\n\n## Sources\n${sourceLines.join("\n")}`;
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
            const first = columnist.name.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "columnist";
            const slug = `${internals.slugify(story.headline).slice(0, 60).replace(/-+$/, "")}-${first}`;
            const article: GeneratedArticle = {
              title: story.headline,
              description: body.trim().slice(0, 160),
              category: "news",
              tags: [],
              keywords: [],
              content,
            };
            const post: GeneratedPost = {
              ...internals.finalizePost(article, slug, story.headline),
              byline: `${columnist.name} — AI columnist persona`,
            };
            await sink.publish(post);
            recordArtifact?.("published", `${post.slug}\n${post.title}\n${post.byline ?? ""}`);
            published = post;
          }
          if (published === null) throw new Error("news-desk: author-versions ran with zero columnists");
          return published;
        }

        // Op-ed-page format: the neutral retell (fixed 3-section plan) + one
        // contract-gated Analysis column per persona under it. Bios render
        // under each header with an explicit AI-persona marker — invented
        // bios must never read as real humans.
        const article = await internals.generate(buildRetellPlan(story.headline));
        const columns: string[] = [];
        for (const columnist of columnists) {
          const column = await composeAnalysis({
            llm,
            persona: columnist,
            evidenceBlock: evidence,
            outletNames,
            parallel,
            maxAttempts: knobs.analysisAttempts,
            log,
          });
          const header = `## Analysis — ${columnist.name}`;
          columns.push(
            columnist.bio === undefined
              ? column
              : column.replace(header, `${header}\n*AI columnist persona — ${columnist.bio}*`),
          );
        }
        const analysis = columns.join("\n\n");
        recordArtifact?.("analysis", analysis);

        // Assembly: retell + Analysis + ## Sources (+ the parallel's Wikipedia
        // line when present).
        // Verification is internal plumbing (operator, 2026-07-23): the reader
        // never sees Wikipedia — no encyclopedia line in Sources.
        const finalArticle = {
          ...article,
          content: `${article.content}\n\n${analysis}\n\n## Sources\n${sourceLines.join("\n")}`,
        };

        // Fact-guard applies to the Analysis too (spec rule, ratified): the
        // informational fact-check audit reads the FINAL assembled markdown —
        // Analysis included — against the evidence corpus. Best-effort like
        // the pipeline's own audit: informational, never a publish gate;
        // failures log loudly and never block the run.
        try {
          const audit = await runFactCheckAudit(finalArticle.content, evidence, {
            llm,
            // model: "" is safe — createOllamaLlm's resolveModel treats blank as
            // the configured default (check-locked in clients/ollama-llm.checks.ts
            // — "blank model resolves to the configured default"); no model knob
            // needed on this call.
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
          recordArtifact?.("fact-check-audit", audit);
        } catch (err: unknown) {
          log?.(`news-desk: fact-check audit failed (informational, non-blocking): ${String(err)}`);
        }

        const slug = internals.slugify(finalArticle.title);
        const post = internals.finalizePost(finalArticle, slug, story.headline);
        await sink.publish(post);
        recordArtifact?.("published", `${post.slug}\n${post.title}`);
        return post;
      }
      throw new Error(`news-desk: no trending story resolved ≥${knobs.minSources} scrapable sources`);
    },
  };
}
