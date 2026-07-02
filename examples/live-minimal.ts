/**
 * examples/live-minimal.ts — the REAL-Phase-2 counterpart to `basic.ts`.
 *
 * Where `basic.ts` proves the port WIRING with fakes (canned LLM, no-op sink,
 * stubbed generation), this runs the genuine pipeline against LIVE services and
 * the batteries-included default preset: an OpenRouter LLM, a real search
 * backend, and `createDefaultInternals(...)` — which binds the engine's REAL
 * editor + gate chain (no stubs on the generation path). The output is a finished
 * article written to `out/<slug>.md`.
 *
 *   npx tsx examples/live-minimal.ts
 *
 * It is OPERATOR-RUN, not wired into vitest: it makes real network calls and
 * needs an API key, so gating CI on it would be flaky. Without OPENROUTER_API_KEY
 * it prints a SKIP line and exits 0, so it is safe to run anywhere.
 *
 * Search backend is chosen by which env var is set — Firecrawl (FIRECRAWL_API_URL)
 * OR SearXNG (SEARXNG_URL); it errors if neither is present. The LLM uses DYNAMIC
 * model selection (no `defaultModel`) — the client picks the current top-weekly
 * free OpenRouter model at runtime (see `clients/openrouter-llm.ts`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { runPipeline } from "../index";
import { createDefaultInternals } from "../presets/default";
import { createOpenRouterLlm } from "../clients/openrouter-llm";
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import { createSearxngSearch } from "../clients/searxng-search";
import type {
  BrandProfile,
  DiscoverySignal,
  GeneratedPost,
  PublishResult,
  SearchClient,
  Sink,
  Source,
} from "../ports";

/** The generic brand this demo publishes under — no real outlet. */
const brand: BrandProfile = {
  name: "Example News",
  publication: "Example News (example.com)",
  beat: "technology",
  bylines: ["A. Writer", "B. Reporter"],
};

/** An inline `Source` with two hand-written signal items (a real adopter points
 *  an `HttpSource`/`RssSource` here, or queries their own data). */
const source: Source = {
  async gatherSignal(): Promise<DiscoverySignal> {
    return {
      framing: "AI infrastructure, last 24h",
      items: [
        {
          title: "A frontier-model lab open-sources its training stack",
          summary:
            "Frontier Labs: released the full pretraining + eval pipeline under Apache-2.0",
          entities: ["Frontier Labs"],
          weight: 5,
        },
        {
          title: "A GPU cloud lands a multi-year capacity deal",
          summary: "Nimbus Compute: signs a multi-year H200 capacity agreement",
          entities: ["Nimbus Compute"],
          weight: 3,
        },
      ],
    };
  },
};

/** Pick the search backend from whichever env var is present; error if neither. */
function resolveSearch(): SearchClient {
  if (process.env.FIRECRAWL_API_URL) {
    return createFirecrawlSearch({
      apiKey: process.env.FIRECRAWL_API_KEY,
      apiUrl: process.env.FIRECRAWL_API_URL,
    });
  }
  if (process.env.SEARXNG_URL) {
    return createSearxngSearch({ baseUrl: process.env.SEARXNG_URL });
  }
  throw new Error(
    "live-minimal: set FIRECRAWL_API_URL (Firecrawl) or SEARXNG_URL (SearXNG) to pick a search backend",
  );
}

/** Run the real pipeline once and write the finished post to `out/<slug>.md`. */
async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    process.stdout.write(
      "SKIP live-minimal — OPENROUTER_API_KEY not set (this example makes live calls)\n",
    );
    return;
  }

  // Dynamic model selection: no `defaultModel` → the client picks the current
  // top-weekly free OpenRouter model at runtime.
  const llm = createOpenRouterLlm({ apiKey: process.env.OPENROUTER_API_KEY });
  const search = resolveSearch();

  const sink: Sink = {
    async publish(post: GeneratedPost): Promise<PublishResult> {
      await mkdir("out", { recursive: true });
      const path = `out/${post.slug}.md`;
      await writeFile(path, post.markdown);
      return { url: path, status: "DRAFT" };
    },
  };

  // The batteries-included path: four ports in, a complete `EngineInternals`
  // (real editor + gate chain) out — no gate wiring of our own.
  const internals = createDefaultInternals({ llm, search, brand, source });

  const post = await runPipeline({
    source,
    sink,
    config: { llm, search, brand },
    internals,
    dryRun: false,
  });

  process.stdout.write(
    `Published "${post.title}" → out/${post.slug}.md [DRAFT]\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`live-minimal failed: ${String(err)}\n`);
  process.exit(1);
});
