/**
 * Checks for index.ts — the public `runPipeline(input)` entry.
 * Run: npx tsx index.checks.ts
 *
 * A golden replay proves a full host's wiring is byte-stable end-to-end; this
 * locks the ENTRY's own orchestration contract in isolation (no host deps):
 *   - it requires `input.internals` (the four public ports can't supply the
 *     full deps) and throws a clear error otherwise;
 *   - it runs the phases in order — discover/plan → generate → publish;
 *   - `input.topic` routes to the seeded plan (planForTopic), an omitted topic
 *     discovers (discoverStory);
 *   - `dryRun` returns the post WITHOUT calling `sink.publish`;
 *   - it returns exactly the `finalizePost` envelope.
 *
 * Discovery makes two LLM calls (query-gen → story-plan); the stub `llm` returns
 * valid Plan/DiscoveryOutput JSON in order so a deterministic plan flows through.
 * `generate` is stubbed (the gate chain is locked by pipeline.checks.ts), so the
 * check stays a pure orchestration lock.
 */
import { runPipeline } from "./index";
import { type Plan } from "./planning";
import { type GeneratedArticle, type PipelineBoardCompany } from "./pipeline";
import {
  type DiscoverySignal,
  type EngineInternals,
  type GeneratedPost,
  type LlmClient,
  type PublishResult,
  type RunInput,
  type Sink,
  type Source,
  type EngineConfig,
} from "./ports";
import { type DiscoveryDeps } from "./discovery";
import { type SectionWriterDeps } from "./section-writer";
import { type AssemblyDeps } from "./assembly";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${name}${detail ? `\n  ${detail}` : ""}\n`);
  }
}

// Silence the entry's + discovery's heavy progress logging.
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true) as typeof process.stdout.write;
function log(s: string): void {
  realWrite(s);
}

// ── A deterministic discovery `llm`, dispatched by PROMPT kind so it serves
// BOTH the discover path (query-gen → story-plan) and the topic path (story-plan
// only — planForTopic skips query-gen). ──
const QUERY_GEN_JSON = JSON.stringify({
  queries: ["query one", "query two"],
  companies: ["Acme"],
});
const STORY_PLAN_JSON = JSON.stringify({
  title: "A Stable Test Story",
  angle: "the through-line",
  category: "frontier",
  searchSeed: "test story",
  sections: [{ heading: "Section One", intent: "establish", queries: [] }],
});
// C4: the theme-recast checkpoint (fires only on the digest path, check 5).
const RECAST_JSON = JSON.stringify({
  verdict: "adjust",
  theme: "Recast theme from the evidence.",
  note: "why",
  newestSourceDate: null,
});
function makeDiscoveryLlm(): LlmClient {
  return {
    async complete(args) {
      return args.prompt.startsWith("You are the research desk")
        ? QUERY_GEN_JSON
        : STORY_PLAN_JSON;
    },
    // The discovery passes are structured now (json_schema): the query-gen +
    // story-plan calls go through completeStructured. Return the same fixture
    // JSON, parsed + validated through the caller's schema (what the live
    // client does), keyed by schemaName.
    async completeStructured(args) {
      const json =
        args.schemaName === "discovery_queries"
          ? QUERY_GEN_JSON
          : args.schemaName === "recast_theme"
            ? RECAST_JSON
            : STORY_PLAN_JSON;
      return args.schema.parse(JSON.parse(json));
    },
  };
}

function makeDiscoveryDeps(): DiscoveryDeps & SectionWriterDeps & AssemblyDeps {
  return {
    llm: makeDiscoveryLlm(),
    gatherSignal: async (): Promise<DiscoverySignal> => ({
      items: [{ title: "Acme", summary: "Acme: hiring", entities: ["Acme"] }],
    }),
    // Non-empty so broadResearch produces a pool (discoverStory throws on empty).
    searchSnippets: async () => ["a snippet"],
    gatherResearch: async () => ({ block: "" }),
    gatherCoveredTopics: async () => [],
    embedDedupSurvivors: async () => null,
    withRetry: async (_label, fn) => fn(),
    getRunId: () => "run_check",
    systemPrompt: () => "",
    runEdit: async (d) => d,
    runFinalEdit: async (a) => a,
    onEvent: async () => undefined,
    onError: () => undefined,
    model: "test-model",
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
    brandName: "Test Brand",
  };
}

interface Trace {
  order: string[];
  publishedSlug: string | null;
  generatedFromTitle: string | null;
  finalizedTopic: string | null;
}

function newTrace(): Trace {
  return {
    order: [],
    publishedSlug: null,
    generatedFromTitle: null,
    finalizedTopic: null,
  };
}

function makeInput(
  trace: Trace,
  opts: { topic?: string; dryRun?: boolean; withInternals?: boolean },
): RunInput {
  const article: GeneratedArticle = {
    title: "A Stable Test Story",
    description: "d",
    category: "frontier",
    tags: ["t"],
    keywords: ["k"],
    content: "# body\n\nprose",
  };
  const internals: EngineInternals = {
    discoveryDeps: makeDiscoveryDeps(),
    generate: async (plan: Plan): Promise<GeneratedArticle> => {
      trace.order.push("generate");
      trace.generatedFromTitle = plan.title;
      return article;
    },
    slugify: (title: string) => title.toLowerCase().replace(/\s+/g, "-"),
    finalizePost: (
      a: GeneratedArticle,
      slug: string,
      topic: string,
    ): GeneratedPost => {
      trace.order.push("finalize");
      trace.finalizedTopic = topic;
      return { slug, title: a.title, markdown: a.content, byline: "Author X" };
    },
  };
  const source: Source = {
    gatherSignal: internals.discoveryDeps.gatherSignal,
  };
  const sink: Sink = {
    publish: async (post: GeneratedPost): Promise<PublishResult> => {
      trace.order.push("publish");
      trace.publishedSlug = post.slug;
      return { url: `/blog/${post.slug}`, status: "PUBLISHED" };
    },
  };
  const config: EngineConfig = {
    llm: internals.discoveryDeps.llm,
    search: { search: async () => [] },
    brand: {
      name: "Test Brand",
      publication: "Test",
      beat: "test",
      bylines: ["Author X"],
    },
  };
  const input: RunInput = {
    source,
    sink,
    config,
    topic: opts.topic,
    dryRun: opts.dryRun,
  };
  if (opts.withInternals !== false) input.internals = internals;
  return input;
}

async function run(): Promise<void> {
  // 1. Missing internals → throws a clear error (the four ports are insufficient).
  {
    const trace = newTrace();
    let threw = false;
    let msg = "";
    try {
      await runPipeline(makeInput(trace, { withInternals: false }));
    } catch (err) {
      threw = true;
      msg = err instanceof Error ? err.message : String(err);
    }
    ok("missing internals throws", threw && /internals/.test(msg), msg);
  }

  // 2. Discover path (no topic): discovery → generate → finalize → publish, in order.
  {
    const trace = newTrace();
    const post = await runPipeline(makeInput(trace, {}));
    ok(
      "discover path order = generate,finalize,publish",
      trace.order.join(",") === "generate,finalize,publish",
      trace.order.join(","),
    );
    ok(
      "generate fed the discovered plan title",
      trace.generatedFromTitle === "A Stable Test Story",
      String(trace.generatedFromTitle),
    );
    ok(
      "finalizePost got the DISCOVERY topic (plan.title), not the headline",
      trace.finalizedTopic === "A Stable Test Story",
      String(trace.finalizedTopic),
    );
    ok(
      "returns the finalizePost envelope (slug from slugify)",
      post.slug === "a-stable-test-story" && post.byline === "Author X",
      `${post.slug} / ${post.byline ?? ""}`,
    );
    ok(
      "published the finalized slug",
      trace.publishedSlug === "a-stable-test-story",
      String(trace.publishedSlug),
    );
  }

  // 3. Topic path: still generate→finalize→publish (planForTopic, seeded).
  {
    const trace = newTrace();
    await runPipeline(makeInput(trace, { topic: "a fixed topic" }));
    ok(
      "topic path still publishes",
      trace.order.join(",") === "generate,finalize,publish",
      trace.order.join(","),
    );
  }

  // 4. dryRun: returns the post but NEVER calls publish.
  {
    const trace = newTrace();
    const post = await runPipeline(makeInput(trace, { dryRun: true }));
    ok(
      "dryRun skips publish",
      !trace.order.includes("publish") &&
        trace.order.join(",") === "generate,finalize",
      trace.order.join(","),
    );
    ok("dryRun still returns the post", post.title === "A Stable Test Story");
  }

  // 5. Part C: the GENERAL research digest. With `digestSection` on the deps
  //    bundle, the entry captures the pooled discovery corpus (discoverStory's
  //    onCorpus seam — chaining any host observer), builds ONE digest
  //    (buildDigest → llm.complete) AFTER planning and BEFORE generate, and
  //    sets it on the SHARED bundle's `generalDigest` (how the pipeline's
  //    write closure reads it — EngineInternals.discoveryDeps IS the adapter's
  //    blogDeps).
  {
    const trace = newTrace();
    const input = makeInput(trace, {});
    const deps = input.internals!.discoveryDeps;
    const digestPrompts: string[] = [];
    const baseLlm = deps.llm;
    deps.llm = {
      // Discovery's two passes are structured; any complete() here is the digest.
      complete: async (args) => {
        digestPrompts.push(args.prompt);
        return "## SCOPE\n- digest bullet";
      },
      completeStructured: baseLlm.completeStructured,
    };
    let hostObserved = "";
    deps.onCorpus = (pool) => {
      hostObserved = pool;
    };
    deps.digestSection = async (raw) => raw;
    let generalAtGenerate: string | undefined;
    let planAtGenerate: Plan | undefined;
    const baseGenerate = input.internals!.generate;
    input.internals!.generate = async (p: Plan) => {
      generalAtGenerate = deps.generalDigest;
      planAtGenerate = p;
      return baseGenerate(p);
    };
    await runPipeline(input);
    ok(
      "digest wiring: host onCorpus still fires (chained), with the pool",
      hostObserved.includes('### Search: "query one"') &&
        hostObserved.includes("- a snippet"),
      hostObserved.slice(0, 80),
    );
    ok(
      "digest wiring: ONE general digest built from the captured corpus",
      digestPrompts.length === 1 &&
        digestPrompts[0].includes('### Search: "query one"') &&
        digestPrompts[0].includes('("general")'),
      `calls=${digestPrompts.length}`,
    );
    ok(
      "digest wiring: generalDigest set on the shared bundle BEFORE generate",
      generalAtGenerate === "## SCOPE\n- digest bullet",
      String(generalAtGenerate),
    );
    // C4: the recast checkpoint runs right after the general digest — a
    // keep/adjust verdict lands on plan.themeStatement so every downstream
    // themeOf(plan) reader sees the recast statement.
    ok(
      "recast wiring: plan.themeStatement set from the verdict BEFORE generate",
      planAtGenerate?.themeStatement === "Recast theme from the evidence.",
      String(planAtGenerate?.themeStatement),
    );
  }

  // 6. Part C counter-case: NO digestSection → the entry neither captures nor
  //    digests — zero free-text LLM calls, generalDigest never touched.
  {
    const trace = newTrace();
    const input = makeInput(trace, {});
    const deps = input.internals!.discoveryDeps;
    let completeCalls = 0;
    let recastCalls = 0;
    const baseLlm = deps.llm;
    deps.llm = {
      complete: async (args) => {
        completeCalls += 1;
        return baseLlm.complete(args);
      },
      completeStructured: async (args) => {
        if (args.schemaName === "recast_theme") recastCalls += 1;
        return baseLlm.completeStructured(args);
      },
    };
    await runPipeline(input);
    ok(
      "no digestSection → no digest call, no recast, generalDigest untouched",
      completeCalls === 0 && recastCalls === 0 && !("generalDigest" in deps),
      `calls=${completeCalls} recasts=${recastCalls} hasField=${"generalDigest" in deps}`,
    );
  }

  // The PipelineBoardCompany import is the contract anchor the entry preserves
  // (the adapter resolves the board generic before crossing the port boundary).
  const _board: PipelineBoardCompany | null = null;
  void _board;

  log(
    failed
      ? `\n${failed} FAILED, ${passed} passed\n`
      : `\nALL ${passed} passed\n`,
  );
  process.stdout.write = realWrite;
  if (failed) process.exit(1);
}

void run();
