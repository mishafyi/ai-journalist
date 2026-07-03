/**
 * FLAGSHIP offline check for `createDefaultInternals` — the centerpiece proof
 * that the REAL Phase-2 pipeline (section research → draft → the real gate
 * chain → SEO) runs end-to-end when the four essentials are wired through the
 * default preset, with NO hand-built `EngineInternals`.
 *
 *   npx tsx presets/default.checks.ts
 *
 * Everything is a deterministic offline fake — no network, no API key — so this
 * runs inside `npm test` via the `test:checks` find-loop.
 *
 * WHY this proves the real pipeline (not a stub): the assertions read the run's
 * TELEMETRY off the published post (`finalizePost` spreads the factory's `ctx
 * .telemetry` into `post.telemetry` — binding point 14). `telemetry.article`
 * only gets its keys (`headline`/`words`/`h2`/`factCheckAudited`) written as the
 * real `runGeneration` threads the draft through the real `runEdit`/
 * `runFinalEdit`/`runTitle`/`runSeo`/fact-check gate chain. `factCheckAudited`
 * is set on the LAST line before the pipeline returns, so its presence proves
 * the WHOLE chain executed — a pass-through stub records none of this.
 *
 * SCHEMA DISPATCH: the fake `LlmClient.completeStructured` must answer every
 * `schemaName` the full run issues. Discovering the complete set was the
 * sanctioned Step-1 iteration — the run threads FOUR structured calls:
 *   - discovery: "discovery_queries" (DiscoveryOutput) + "story_plan" (Plan)
 *   - gate chain: "headline_candidates" (TitleResultSchema {candidates,best})
 *                 + "seo_metadata" (SeoMetaSchema {title,description,seoTitle,
 *                   seoDescription,tags,keywords})
 * Each fixture is validated through the caller's own Zod schema (`args.schema
 * .parse(...)`), exactly what a real json_schema client guarantees, so a wrong
 * shape throws at the call site (how the set above was found).
 */
import { runPipeline } from "../index";
import { createDefaultInternals } from "./default";
import type {
  BrandProfile,
  DiscoverySignal,
  GeneratedPost,
  LlmClient,
  PublishResult,
  SearchClient,
  Sink,
  Source,
} from "../ports";

let failures = 0;
const ok = (name: string, cond: boolean, detail: string): void => {
  if (cond) process.stdout.write(`PASS ${name}\n`);
  else {
    failures += 1;
    process.stdout.write(`FAIL ${name} — ${detail}\n`);
  }
};

/** A generic offline brand — no real outlet, guard-safe. */
const brand: BrandProfile = {
  name: "Test Wire",
  publication: "Test Wire (test.example)",
  beat: "technology",
  bylines: ["A. Reporter", "B. Editor"],
};

/**
 * Deterministic fake `LlmClient`. `complete` (free-text: sections + the two
 * editor passes + fact-guard/fact-check) returns a fixed multi-H2 markdown body.
 * `completeStructured` dispatches on every `schemaName` the full run issues and
 * returns fixture JSON validated through the caller's own Zod schema.
 */
// A fixed, article-shaped markdown body used for BOTH the section writes and the
// two editor passes (runEdit → runFinalEdit REPLACE the whole body with the
// LLM's return, so this constant is the pipeline's final body). It must clear
// the engine's HARD pre-persist shape gate: ≥800 words, ≥3 H2 sections, NO H1
// (sections start at H2; assemble adds the H1). Every paragraph is DISTINCT so
// the sentence-dedup pass (drops later duplicate sentences ≥60 chars) can't
// collapse the word count, and the prose stays grounded in the fake research so
// no repetition/fact-guard gate trips.
const ARTICLE_PARAS = [
  "Acme Robotics confirmed the expansion in a regulatory filing that named specific engineering teams, and analysts who track the sector read it as a concrete demand signal rather than routine backfill. The company said the newly posted roles span controls, perception, and manufacturing, with most of them aimed squarely at senior engineers who are already scarce across the wider industry. Recruiters describe a market in which a single well-funded employer can pull experienced talent away from incumbents faster than those incumbents can plausibly respond, and this week's filing suggests Acme Robotics intends to do precisely that at scale.",
  "The postings themselves, read against publicly available compensation data, point to a hiring race that is now measured in weeks rather than in fiscal quarters. Hiring managers at rival firms told reporters that the compressed timelines leave them little room to counter an aggressive offer, especially when the candidate already holds deployed hardware experience. Several noted that the scarcest profiles are not fresh graduates but mid-career specialists who can ship a working perception stack, and that those specialists are exactly the people the new listings target most directly and most persistently.",
  "Zooming out, the surge tracks a broader structural shift toward physical automation that has been building quietly for several years across logistics, warehousing, and light manufacturing. Where earlier waves of robotics investment chased demonstrations and pilots, the current wave is anchored in paying customers and repeat orders, which changes the calculus for how quickly a company must staff up. That shift is why a single company's expansion reads less like an isolated event and more like an early, visible symptom of demand that the labor market has not yet fully priced in.",
  "It also reshapes the competitive map in ways that are easy to underestimate from the outside. When one employer sets a new pay and equity benchmark for a narrow specialty, that benchmark propagates through the whole talent pool within a single hiring cycle, and slower-moving incumbents inherit a cost structure they did not choose. Executives who have lived through previous talent races warn that the firms who wait for the market to settle usually discover that it has already settled against them, with the strongest candidates committed elsewhere long before the budget is approved.",
  "For workers, the immediate consequence is leverage of a kind that robotics engineers have rarely enjoyed, and many are using it deliberately and unapologetically. Offers now routinely bundle accelerated equity, relocation support, and explicit commitments about which product line a hire will own, because vague roles no longer clear the market. Career coaches report a marked uptick in candidates fielding several competing bids at once, and they advise treating the current window as a moment to negotiate specifics rather than titles, since the specifics are what will actually determine day-to-day work.",
  "What comes next depends on whether demand holds through the next few funding cycles or cools as capital tightens and interest rates stay elevated for longer than the sector expects. Optimists point to firm order books and to customers who have already reorganized operations around automated systems they cannot easily abandon. Skeptics counter that hiring sprees are a lagging indicator and that the same filings could look premature if a single large customer pulls back. Either way, the coming quarter should reveal whether this week's expansion was the leading edge of a durable trend or a well-timed bet.",
  "Investors reading the same tea leaves have started asking portfolio companies pointed questions about their own staffing plans, wary of being caught flat-footed if a rival locks up the available specialists first. Board members who once treated engineering headcount as a back-office detail now raise it in the first ten minutes of a review, and founders have learned to arrive with a defensible plan for where the next dozen hires will come from. That scrutiny, several partners argued, is healthy discipline that forces companies to justify growth against real orders rather than against a competitor's press release.",
  "Universities and specialized training programs sit at the other end of the pipeline, and their response will shape how long the crunch lasts beyond the current cycle. Program directors describe waiting lists for the exact courses that produce deployable robotics engineers, and they caution that curricula take years to retool even when the demand signal is unmistakable. In the near term, that lag means employers cannot simply train their way out of the shortage, and the ones who thrive will be those that build credible internal ladders to grow mid-level engineers into the senior roles the market refuses to supply.",
  "Regulators and standards bodies form the quiet backdrop to all of this, and their pace will influence which roles prove most durable once the initial rush subsides. Safety certification for physical systems remains slow and expensive, which paradoxically raises the value of engineers who understand compliance as well as code, since those hybrid profiles unblock revenue rather than merely adding features. Companies that staffed those functions early are now moving faster through approvals, and that operational edge, more than any single product demo, may end up separating the firms that endure from the ones that stall.",
];

const ARTICLE_BODY = [
  "## What Happened",
  "",
  ARTICLE_PARAS[0],
  "",
  ARTICLE_PARAS[1],
  "",
  ARTICLE_PARAS[6],
  "",
  "## Why It Matters",
  "",
  ARTICLE_PARAS[2],
  "",
  ARTICLE_PARAS[3],
  "",
  ARTICLE_PARAS[7],
  "",
  "## What Comes Next",
  "",
  ARTICLE_PARAS[4],
  "",
  ARTICLE_PARAS[5],
  "",
  ARTICLE_PARAS[8],
].join("\n");

const fakeLlm: LlmClient = {
  async complete() {
    return ARTICLE_BODY;
  },
  async completeStructured(args) {
    if (args.schemaName === "discovery_queries") {
      return args.schema.parse({
        queries: [
          "acme robotics hiring surge",
          "robotics engineering talent demand",
        ],
        companies: ["Acme Robotics"],
      });
    }
    if (args.schemaName === "story_plan") {
      return args.schema.parse({
        title: "Acme Robotics Goes on a Hiring Spree",
        angle: "a single company's hiring reveals a sector-wide talent race",
        category: "technology",
        searchSeed: "acme robotics hiring",
        sections: [
          { heading: "What Happened", intent: "establish the news", queries: [] },
          { heading: "Why It Matters", intent: "widen to the sector", queries: [] },
        ],
      });
    }
    if (args.schemaName === "headline_candidates") {
      return args.schema.parse({
        candidates: [
          "Acme Robotics Goes on a Hiring Spree as the Talent Race Heats Up",
          "Inside the Robotics Talent Race",
        ],
        best: "Acme Robotics Goes on a Hiring Spree as the Talent Race Heats Up",
      });
    }
    if (args.schemaName === "seo_metadata") {
      return args.schema.parse({
        title: "Acme Robotics Goes on a Hiring Spree",
        description: "Acme Robotics' hiring surge signals a sector-wide talent race.",
        seoTitle: "Acme Robotics Hiring Spree — The Robotics Talent Race",
        seoDescription:
          "Acme Robotics posted a batch of new engineering roles, a signal of accelerating robotics demand.",
        tags: ["robotics", "hiring"],
        keywords: ["acme robotics", "robotics talent"],
      });
    }
    throw new Error(`unexpected schemaName in flagship fake: ${args.schemaName}`);
  },
};

/** Offline `SearchClient` — canned results (non-empty so discovery's broad
 *  research pool + each section's snippet research have material to fold). */
const fakeSearch: SearchClient = {
  async search() {
    return [
      {
        title: "Robotics hiring accelerates",
        url: "https://news.example/robotics-hiring",
        snippet: "Companies across robotics are expanding engineering headcount.",
      },
      {
        title: "The automation talent crunch",
        url: "https://news.example/talent-crunch",
        snippet: "Demand for robotics engineers outpaces supply, analysts say.",
      },
    ];
  },
};

/** Inline 2-item `Source` — the raw discovery signal. No facts, no covered
 *  topics (exercises the neutral-mode empty guards). */
const source: Source = {
  async gatherSignal(): Promise<DiscoverySignal> {
    return {
      framing: "robotics hiring, last 24h",
      items: [
        {
          title: "Acme Robotics is hiring",
          summary: "Acme Robotics: 128 open roles across robotics engineering",
          entities: ["Acme Robotics"],
          weight: 128,
        },
        {
          title: "Globex trims its robotics division",
          summary: "Globex: layoffs across the 2026 robotics line",
          entities: ["Globex"],
          weight: 3,
        },
      ],
    };
  },
};

async function runFlagship(): Promise<void> {
  // A mutable holder — object property reads keep their declared type (TS won't
  // flow-narrow a closure-only assignment to `null`, which a bare `let` would).
  const sinkSaw: { post: GeneratedPost | null; published: PublishResult | null } =
    { post: null, published: null };

  // Capture Sink — records the post the pipeline published.
  const sink: Sink = {
    async publish(post: GeneratedPost): Promise<PublishResult> {
      const result: PublishResult = {
        url: `out/${post.slug}.md`,
        status: "DRAFT",
      };
      sinkSaw.post = post;
      sinkSaw.published = result;
      return result;
    },
  };

  // THE POINT: internals assembled from ~4 inputs by the default preset — NOT
  // hand-built. Deterministic runId so the run is reproducible.
  const internals = createDefaultInternals({
    llm: fakeLlm,
    search: fakeSearch,
    brand,
    source,
    runId: "flagship_run",
  });

  const post = await runPipeline({
    source,
    sink,
    config: { llm: fakeLlm, search: fakeSearch, brand },
    internals,
  });

  // (a) runPipeline resolved with a preset-built internals.
  ok(
    "runPipeline resolves through createDefaultInternals",
    post !== null && typeof post.markdown === "string",
    "expected a GeneratedPost with markdown",
  );
  // (b) the post's markdown carries at least one H2 (the real sections survived
  //     assembly + the editor passes).
  ok(
    "post markdown contains at least one '## ' heading",
    /^##\s/m.test(post.markdown),
    `no H2 in markdown:\n${post.markdown.slice(0, 200)}`,
  );
  // (c) the sink received the SAME post the pipeline returned, with a non-empty
  //     slug + title. Field checks read off `post` (properly typed by
  //     runPipeline); the reference-identity check proves the sink saw it.
  ok(
    "sink received the pipeline's post with a non-empty slug + title",
    sinkSaw.post === post &&
      typeof post.slug === "string" &&
      post.slug.length > 0 &&
      post.title.length > 0,
    `slug=${JSON.stringify(post.slug)} title=${JSON.stringify(post.title)} sinkSawPost=${sinkSaw.post === post}`,
  );
  ok(
    "published DRAFT to the expected out/ url",
    sinkSaw.published?.url === `out/${post.slug}.md`,
    `published=${JSON.stringify(sinkSaw.published)} expected=out/${post.slug}.md`,
  );
  // (d) the REAL runGeneration + gate chain executed. `finalizePost` spreads
  //     the factory's ctx.telemetry into post.telemetry, and `telemetry.article`
  //     is written ONLY by the real gate chain. `factCheckAudited` is set on the
  //     last line before runGeneration returns, so its presence proves the WHOLE
  //     chain (draft → edit → final-edit → fact-guard → title → seo → link-gate
  //     → fact-check-audit) ran — a pass-through stub records none of this.
  const telemetry = (post.telemetry ?? {}) as {
    topic?: string;
    article?: Record<string, unknown>;
  };
  const article = telemetry.article ?? {};
  ok(
    "post telemetry carries the discovery topic (proves finalizePost ran)",
    telemetry.topic === "Acme Robotics Goes on a Hiring Spree",
    `telemetry.topic=${JSON.stringify(telemetry.topic)}`,
  );
  ok(
    "telemetry.article recorded gate-chain metrics (headline + words + h2)",
    typeof article.headline === "string" &&
      typeof article.words === "number" &&
      (article.words as number) > 0 &&
      typeof article.h2 === "number" &&
      (article.h2 as number) >= 1,
    `telemetry.article=${JSON.stringify(article)}`,
  );
  ok(
    "telemetry.article.factCheckAudited === true (whole gate chain executed)",
    article.factCheckAudited === true,
    `factCheckAudited=${JSON.stringify(article.factCheckAudited)}`,
  );
  // (e) neutral-mode hygiene — the Task-1 empty guards held: no "undefined"
  //     leak, no zero-inventory site block, no " 0 open " garbage in the post.
  ok(
    "neutral-mode hygiene: no 'undefined' in markdown",
    !post.markdown.includes("undefined"),
    "markdown leaked an 'undefined'",
  );
  ok(
    "neutral-mode hygiene: no 'FIRST-PARTY SITE INVENTORY' block",
    !post.markdown.includes("FIRST-PARTY SITE INVENTORY"),
    "zero-inventory site block leaked",
  );
  ok(
    "neutral-mode hygiene: no ' 0 open ' garbage",
    !post.markdown.includes(" 0 open "),
    "zero-open-roles garbage leaked",
  );
}

/**
 * The `embedder` option — a supplied `Embedder` upgrades the preset's
 * `embedDedupSurvivors` from the constant `async () => null` (trigram-only
 * fallback) to a REAL embedding-grade near-paraphrase dedup, bound into BOTH
 * `discoveryDeps` and `gateDeps`. This proves the generic derivation drops a
 * paraphrase (cosine ≥ threshold against a covered topic) while a novel
 * candidate survives, and that omitting the embedder preserves today's `null`.
 */
async function runEmbedderChecks(): Promise<void> {
  // ── embedder option: generic embedDedupSurvivors derivation ─────────────────
  {
    // A fake embedder with fixed vectors: "same story" pairs are identical
    // (sim 1.0), everything else orthogonal (sim 0.0).
    const VEC: Record<string, number[]> = {
      "NASA delays Artemis crew flight": [1, 0, 0],
      "Artemis slips again": [1, 0, 0], // paraphrase — same vector
      "DoD hiring surge in cyber roles": [0, 1, 0],
    };
    const fakeEmbedder = {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((t) => VEC[t] ?? [0, 0, 1]);
      },
    };
    const withEmb = createDefaultInternals({
      llm: fakeLlm,
      search: fakeSearch,
      brand,
      source,
      embedder: fakeEmbedder,
    });
    const dedup = withEmb.discoveryDeps.embedDedupSurvivors;
    const res = await dedup(
      ["Artemis slips again", "DoD hiring surge in cyber roles"],
      ["NASA delays Artemis crew flight"],
      0.9,
    );
    ok(
      "embedder: paraphrase dropped, novel survives",
      res !== null &&
        res.survivors.length === 1 &&
        res.survivors[0] === "DoD hiring surge in cyber roles" &&
        res.dropped.length === 1 &&
        res.dropped[0].sim > 0.99,
      JSON.stringify(res),
    );
    const without = createDefaultInternals({
      llm: fakeLlm,
      search: fakeSearch,
      brand,
      source,
    });
    ok(
      "no embedder: embedDedupSurvivors returns null (trigram-only fallback)",
      (await without.discoveryDeps.embedDedupSurvivors(["a"], ["b"], 0.9)) ===
        null,
      "must be null when embedder omitted",
    );
  }
}

runFlagship()
  .then(runEmbedderChecks)
  .then(() => {
    process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nALL passed\n");
    if (failures) process.exit(1);
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `flagship check threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
