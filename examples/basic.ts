/**
 * examples/basic.ts — the smallest end-to-end run of the engine with ZERO real
 * services. It proves `runPipeline(input)` executes the full discover → generate
 * → publish flow against:
 *
 *   - a FAKE `LlmClient` that returns canned strings (no network, no API key);
 *   - an inline `Source` carrying a couple of hand-written `SignalItem`s;
 *   - a no-op `Sink` that just records where the post "landed";
 *   - a generic `brand = { name: "Example News", … }`.
 *
 * It is also a runnable vitest test (`examples/basic.test.ts` imports it), so CI
 * exercises the wiring. Run it standalone with:
 *
 *   npx tsx examples/basic.ts
 *
 * NOTE on `internals`: the four PUBLIC ports (Source / Sink / Linker /
 * EngineConfig) are the minimal contract, but `runPipeline` also needs the
 * adapter-internal `EngineInternals` carrier — the Phase-2 generation closure +
 * slug/finalize helpers the public ports can't express (see `ports.ts`). A real
 * adopter wires these to their own gate chain; here they are tiny stubs so the
 * example stays self-contained and offline. The point of the demo is the
 * port wiring + call order, not the (proprietary) gate chain itself.
 */
import { runPipeline } from "../index";
import type { GeneratedArticle } from "../pipeline";
import type { Plan } from "../planning";
import type { DiscoveryDeps } from "../discovery";
import type { SectionWriterDeps } from "../section-writer";
import type { AssemblyDeps } from "../assembly";
import type {
  BrandProfile,
  DiscoverySignal,
  EngineConfig,
  EngineInternals,
  GeneratedPost,
  LlmClient,
  PublishResult,
  SearchClient,
  Sink,
  Source,
} from "../ports";

/** The generic brand the demo publishes under — no real outlet. */
const brand: BrandProfile = {
  name: "Example News",
  publication: "Example News (example.com)",
  beat: "technology",
  bylines: ["A. Writer"],
};

/**
 * A FAKE `LlmClient`. `complete` returns a fixed article body; `completeStructured`
 * dispatches on the discovery `schemaName` and returns fixture JSON validated
 * through the caller's own Zod schema (exactly what a real json_schema client
 * guarantees), so discovery's query-gen → story-plan passes flow deterministically.
 */
const fakeLlm: LlmClient = {
  async complete() {
    return "# Example Headline\n\nA canned article body for the offline demo.";
  },
  async completeStructured(args) {
    const json =
      args.schemaName === "discovery_queries"
        ? JSON.stringify({
            queries: ["what is happening in widgets", "widget market shifts"],
            companies: ["Acme Widgets"],
          })
        : JSON.stringify({
            title: "Acme Widgets Ships a Faster Widget",
            angle: "a small company moves the whole market",
            category: "technology",
            searchSeed: "acme widgets",
            sections: [
              { heading: "What Happened", intent: "establish the news", queries: [] },
            ],
          });
    return args.schema.parse(JSON.parse(json));
  },
};

/** A trivial offline `SearchClient` — returns no results (the demo doesn't research). */
const fakeSearch: SearchClient = {
  async search() {
    return [];
  },
};

/**
 * The INPUT port: an inline `Source` with two hand-written `SignalItem`s. A real
 * adopter would point an `HttpSource`/`RssSource` here, or query their own data.
 */
const source: Source = {
  async gatherSignal(): Promise<DiscoverySignal> {
    return {
      framing: "widget industry, last 24h",
      items: [
        {
          title: "Acme Widgets is hiring",
          summary: "Acme Widgets: 42 open roles in widget manufacturing",
          entities: ["Acme Widgets"],
          weight: 42,
        },
        {
          title: "Globex announces a widget recall",
          summary: "Globex: product recall across the 2026 widget line",
          entities: ["Globex"],
          weight: 1,
        },
      ],
    };
  },
};

/** Where the published post landed — captured by the no-op Sink for the assertion. */
export interface DemoResult {
  post: GeneratedPost;
  published: PublishResult | null;
}

/**
 * Run the demo pipeline once and return the finished post + what the Sink saw.
 * Pure: takes no globals, returns the result so a test can assert on it.
 */
export async function runBasicExample(): Promise<DemoResult> {
  let published: PublishResult | null = null;

  // The OUTPUT port: a no-op Sink. The one method an adopter must implement —
  // here it just records the post instead of writing a file / calling a CMS.
  const sink: Sink = {
    async publish(post: GeneratedPost): Promise<PublishResult> {
      const result: PublishResult = {
        url: `out/${post.slug}.md`,
        status: "DRAFT",
      };
      published = result;
      return result;
    },
  };

  // The discovery + section-writer + assembly deps bundle. Everything is an
  // offline stub: the fake LLM, a no-research source, pass-through edits, and the
  // documented default knob values.
  const discoveryDeps: DiscoveryDeps & SectionWriterDeps & AssemblyDeps = {
    llm: fakeLlm,
    gatherSignal: source.gatherSignal,
    // Non-empty so discovery's broad-research pool isn't empty (it throws on empty).
    searchSnippets: async () => ["a canned research snippet"],
    gatherResearch: async () => ({ block: "" }),
    gatherCoveredTopics: async () => [],
    embedDedupSurvivors: async () => null,
    withRetry: async (_label, fn) => fn(),
    getRunId: () => "example_run",
    systemPrompt: () => "",
    runEdit: async (draft) => draft,
    runFinalEdit: async (article) => article,
    onEvent: async () => undefined,
    onError: () => undefined,
    // Knobs — the documented defaults (the engine reads no env).
    model: "fake-model",
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
    brandName: brand.name,
  };

  // The adapter-internal carrier. A real adopter binds these to their gate chain;
  // the demo stubs Phase-2 generation so the run stays offline + self-contained.
  const internals: EngineInternals = {
    discoveryDeps,
    generate: async (plan: Plan): Promise<GeneratedArticle> => ({
      title: plan.title,
      description: "A short demo description.",
      category: plan.category ?? brand.beat,
      tags: ["demo"],
      keywords: ["example"],
      content: `# ${plan.title}\n\nGenerated offline by ${brand.name}.`,
    }),
    slugify: (title: string) =>
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    finalizePost: (
      article: GeneratedArticle,
      slug: string,
      topic: string,
    ): GeneratedPost => ({
      slug,
      title: article.title,
      markdown: article.content,
      description: article.description,
      byline: brand.bylines[0],
      telemetry: { topic },
    }),
  };

  const config: EngineConfig = {
    llm: fakeLlm,
    search: fakeSearch,
    brand,
  };

  const post = await runPipeline({ source, sink, config, internals });
  return { post, published };
}

// When executed directly (`npx tsx examples/basic.ts`), run it and print the result.
if (import.meta.url === `file://${process.argv[1]}`) {
  runBasicExample()
    .then(({ post, published }) => {
      process.stdout.write(
        `Published "${post.title}" → ${published?.url ?? "(not published)"} ` +
          `[${published?.status ?? "?"}]\n\n${post.markdown}\n`,
      );
    })
    .catch((err: unknown) => {
      process.stderr.write(`example failed: ${String(err)}\n`);
      process.exit(1);
    });
}
