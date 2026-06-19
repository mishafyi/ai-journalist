# AI Journalist

**An AI journalist behind hexagonal ports — plug in any data source, get a finished article out.**

A **domain-agnostic** blog-generation pipeline: given a _signal_ ("what's
happening"), it discovers a story, researches it, writes it through an
LLM + deterministic-gate chain, and emits a finished post — driven by **any**
data source.

Engine code imports **nothing** from a host app, ORM, or framework — everything
domain-specific is injected through the ports in [`ports.ts`](./ports.ts). An
ESLint boundary rule + an AST purity guard enforce this in CI, so a host's
private side can never leak into the engine.

## Install

```bash
npm i ai-journalist
```

Peer runtime: Node 22+. The engine is ESM (`"type": "module"`) and ships as
TypeScript source — consume it via `tsx`, or your own bundler. Its npm deps are
`zod`, `p-limit`, `@openrouter/sdk`, `firecrawl`, `rss-parser`, `date-fns`,
`remark` + `remark-gfm` + `unist-util-visit` (plus `node:` built-ins).
`npm run build` type-checks (`tsc --noEmit`); `npm test` runs the byte-lock +
purity checks **and** the offline end-to-end example
([`examples/basic.ts`](./examples/basic.ts)).

## The contract

[`ports.ts`](./ports.ts) is the entire customization surface and is the
authoritative reference — read its docstrings. A minimal adopter brings a
**Source** (their data), an **EngineConfig** (an LLM + search client + brand),
and implements **`publish(post)`** — there is no Sink class to subclass; the Sink
is just an object with a `publish` method (a file, a CMS, your own API):

```ts
import { writeFile } from "node:fs/promises";
import { runPipeline } from "ai-journalist";
import { createHttpSource } from "ai-journalist/sources";
import {
  createOpenRouterLlm,
  DEFAULT_MODEL,
} from "ai-journalist/clients/openrouter-llm";
import { createFirecrawlSearch } from "ai-journalist/clients/firecrawl-search";

await runPipeline({
  source: createHttpSource({ signalUrl: "https://my-api/signal" }), // your data
  sink: {
    // YOU implement publish() — where the finished post lands (no Sink class ships)
    async publish(post) {
      await writeFile(`out/${post.slug}.md`, post.markdown);
      return { url: `out/${post.slug}.md`, status: "DRAFT" };
    },
  },
  config: {
    // `defaultModel` is required — a STABLE id (DEFAULT_MODEL is the bundled one);
    // `apiKey` falls back to OPENROUTER_API_KEY.
    llm: createOpenRouterLlm({
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultModel: DEFAULT_MODEL,
    }),
    // `apiUrl` is required (or set FIRECRAWL_API_URL); `apiKey` → FIRECRAWL_API_KEY.
    search: createFirecrawlSearch({
      apiKey: process.env.FIRECRAWL_API_KEY,
      apiUrl: process.env.FIRECRAWL_API_URL,
    }),
    brand: {
      name: "My Outlet",
      publication: "My Outlet (myoutlet.com)",
      beat: "your beat",
      bylines: ["A. Writer"],
    },
  },
  // internals, — the adapter-internal carrier the four public ports can't express
  //              (the Phase-2 generation closure + slug/finalize helpers — see
  //              `EngineInternals` in ports.ts and `examples/basic.ts`).
  // topic,     — optional: a fixed topic; omit for autonomous discovery from the signal
  // linker,    — optional: on-site entity links (omit → no internal links)
  // dryRun,    — optional: return the post instead of publishing
});
```

`runPipeline(input)` returns the `GeneratedPost` either way (a dry run yields it
for inspection without publishing). For a complete, **offline, runnable** wiring
— a fake `LlmClient`, an inline `Source`, a no-op `Sink`, and the `internals`
carrier — see [`examples/basic.ts`](./examples/basic.ts) (`npx tsx examples/basic.ts`).

## "Plug any data in" — three layers of effort

| Layer | You bring                                                                                      | Engine code             |
| ----- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| 1     | An endpoint returning `DiscoverySignal`/`GroundingFacts` → `HttpSource({signalUrl, factsUrl})` | none                    |
| 2     | Any endpoint + a `mapSignal: (raw) => DiscoverySignal`                                         | none                    |
| 3     | A custom `Source` (DB / file / scrape)                                                         | implement one interface |

The built-in sources ([`sources/`](./sources): `HttpSource`, `RssSource`,
`FileSource`, `composeSources`) all implement the **input** `Source`, so the
common cases are **config, not code**. The **output** is always yours: the engine
ships reference clients (OpenRouter LLM + Firecrawl search) and reference sources,
but **no Sink class** — `publish(post)` is the one port you implement (a file, a
CMS, your API). A Layer-3 adopter implements `Source` directly (e.g. a DB query
with aggregations the wire contract can't express).

## Layout

```
index.ts          public entry — runPipeline(input: RunInput)
ports.ts          the hexagonal contract (Source/Sink/Linker/EngineConfig + RunInput)
schemas.ts        Zod validators for the wire DTOs (parseSignal/parseFacts/parseCovered)

discovery.ts      signal → LLM query-gen → research → story pick (Phase 1)
pipeline.ts       runGeneration — section research → draft → gate chain (Phase 2)
section-writer.ts per-section drafting
gates.ts          the 6 LLM gate/edit passes (edit, fact-guard, fact-check, title, seo, final)
assembly.ts       section stitching + internal-link assembly
planning.ts       Plan/outline types + helpers
text.ts           pure text utilities (trigram dedup, repetition budgets, …)
news.ts           --from-news discovery helpers + host blocklist
primitives.ts     trigramSimilarity / sharesEntityEvent
run-context.ts    per-run telemetry + artifact + runId carrier (no module globals)
build-headline-corpus.ts / headlines.json   NYT/WSJ headline corpus for the title gate

sources/          Http / Rss / File / compose — the reference Source library
clients/          OpenRouter LlmClient + Firecrawl SearchClient (the default config clients)
testing/replay.ts record/replay harness (sha256-keyed) for deterministic tests
*.checks.ts       per-module byte-lock + behavioral checks (run by `npm run test:checks`)
examples/         offline, runnable end-to-end demo (`basic.ts` + its vitest wrapper)
```

## Purity & testing — enforced in CI

- **Boundary:** the core imports only sibling engine modules and is
  `process.env`-free (clients read keys; the core takes config).
  `__guard.checks.ts` is an AST-based guard that fails on any `process.env` read,
  `owl-alpha` model-id literal, or hardcoded brand literal (`Example News` /
  `example.com`) in the core — brand text is supplied via `BrandProfile.name` and
  threaded as `${brand.name}`.
- **Behavior:** `npm run test:checks` runs the AST guard + all `*.checks.ts`
  (byte-locks that pin the exact LLM prompts — catching prompt drift). The
  `*.checks.ts` are standalone `tsx` scripts (NOT vitest), so they are run by the
  shell loop and excluded from the vitest glob.
- **Example:** `npm run test:example` runs the offline end-to-end demo under
  vitest. `npm test` runs both.

## Design notes

- **`EngineInternals` carrier.** A full host pipeline typically needs more than
  the four public ports can carry — e.g. several content-rewriting link functions
  interleaved at multiple pipeline points, plus per-run telemetry the minimal
  `Linker.resolveLinks` / `Sink.recordRun` shapes can't express. That remainder
  rides an optional, engine-pure `EngineInternals` carrier on `RunInput` (see
  `ports.ts`). `runPipeline` requires it; [`examples/basic.ts`](./examples/basic.ts)
  shows a minimal offline implementation.
- **Externalized brand.** The short brand name once baked into the
  `section-writer.ts` + `pipeline.ts` default prompts is externalized to
  `BrandProfile.name` and threaded via `${brand.name}` (locked by the guard's
  brand-literal rule).

## License

[MIT](./LICENSE) — see the `LICENSE` file for the copyright notice.
