# AI Journalist

[![npm](https://img.shields.io/npm/v/ai-journalist.svg)](https://www.npmjs.com/package/ai-journalist)
[![CI](https://github.com/mishafyi/ai-journalist/actions/workflows/ci.yml/badge.svg)](https://github.com/mishafyi/ai-journalist/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](https://nodejs.org)

**An autonomous AI journalist behind hexagonal ports — feed it your data signal, get a researched, fact-guarded, edited article out.**

Point it at whatever your product knows (a live dataset, an API, an RSS feed)
and it runs the full newsroom loop on top: **discover** a story worth telling,
**research** it across the web, **write** it section by section against the
evidence, then push it through an **editor + fact-integrity gate chain** before
a single word is published. Domain-agnostic by construction: the engine imports
nothing from any host app, and everything brand- or domain-specific arrives
through typed ports.

## Why it's different

Most "AI blog writers" are a prompt in a trench coat. This is a **pipeline with
editorial machinery**, hardened in production:

- **Grounded by construction** — sections are written from researched,
  source-tiered material (wire/gov primary sources ranked first, low-authority
  hosts down-ranked and labeled; re-reported claims chased to their primary
  source). An extractive digest layer keeps prompts sharp while the *raw*
  corpus remains the guards' ground truth.
- **Fact-integrity gates** — a fact-guard pass strips fabricated people,
  scenes, quotes, relationships, and unsourced statistics; a fact-check audit
  rates every claim against the research and can force a weak article to DRAFT
  instead of publishing it.
- **A real editorial desk** — a theme statement recast against what research
  actually found (stale or dead stories get killed, not published), newspaper
  line-edit and managing-editor passes with explicit length floors, headline
  candidates judged against a corpus of editor-written exemplars, structure and
  corroboration gates.
- **Deterministic guardrails around every LLM step** — repetition budgets,
  figure-grounding checks, attribution budgets, title-candidate membership,
  length-ratio guards. Models drift; the gates don't.
- **Total provenance** — every prompt, response, search, digest, and gate
  verdict is recorded per run through a pluggable run-context, so any article
  can be audited after the fact.

## Install

```bash
npm i ai-journalist
```

Node 20+ (CI tests 20 and 22), ESM, ships as TypeScript source — consume it via
`tsx` or your own bundler. Dependencies are small and boring: `zod`, `p-limit`,
`@openrouter/sdk`, `firecrawl`, `rss-parser`, `date-fns`, `remark`.

## Quickstart

A minimal adopter brings four things — a **Source** (your data), an
**LlmClient**, a **SearchClient**, and a **BrandProfile** — and the
batteries-included preset assembles the rest:

```ts
import { runPipeline } from "ai-journalist";
import { createDefaultInternals } from "ai-journalist/presets";
import { createHttpSource } from "ai-journalist/sources";
import { createOpenRouterLlm } from "ai-journalist/clients/openrouter-llm";
import { createFirecrawlSearch } from "ai-journalist/clients/firecrawl-search";

const source = createHttpSource({ signalUrl: "https://my-api/signal" });
const llm = createOpenRouterLlm({}); // OPENROUTER_API_KEY; dynamic model selection
const search = createFirecrawlSearch({ apiUrl: process.env.FIRECRAWL_API_URL });
const brand = {
  name: "My Outlet",
  publication: "My Outlet (myoutlet.com)",
  beat: "your beat",
  bylines: ["A. Writer"],
};

await runPipeline({
  source,
  sink: { publish: async (post) => ({ url: `out/${post.slug}.md`, status: "DRAFT" }) },
  config: { llm, search, brand },
  internals: createDefaultInternals({ llm, search, brand, source }),
});
```

Two runnable demos ship in [`examples/`](./examples): `basic.ts` (fully
offline — also the CI wiring proof) and `live-minimal.ts` (real LLM + search,
writes `out/<slug>.md`, safely prints `SKIP` without keys).

## The contract

[`ports.ts`](./ports.ts) is the entire customization surface — four public
ports, typed and documented in place:

| Port           | What you decide                                                                  |
| -------------- | -------------------------------------------------------------------------------- |
| `Source`       | Where signal + grounding facts come from (`Http`/`Rss`/`File` ship; or your own) |
| `Sink`         | Where finished posts land — one `publish(post)` function, no class to subclass   |
| `EngineConfig` | Which LLM, which search backend, your brand identity/voice, ~70 documented knobs |
| `Linker`       | Optional on-site entity links                                                    |

"I want to change X" → [`CUSTOMIZING.md`](./CUSTOMIZING.md) maps every seam.
Search is fully swappable (`SearchClient` port): reference clients ship for
[Firecrawl](https://firecrawl.dev) (cloud or self-hosted) and self-hosted
[SearXNG](https://github.com/searxng/searxng), with no baked-in hosts.

## Guarantees, enforced in CI

- **Purity** — an AST guard fails the build on any `process.env` read or
  hardcoded brand/host literal inside the core: everything host-specific must
  arrive through the ports.
- **Prompt stability** — 300+ byte-lock checks pin the exact text of every LLM
  prompt, so prompt drift is a failing test, never a production surprise.
- **Wiring** — the offline end-to-end example runs under vitest on every push.

## Releases

Semver, with a [`CHANGELOG.md`](./CHANGELOG.md) section per version. Every
release is published to npm **and** GitHub Releases from the same tag by CI
(npm trusted publishing, tokenless).

## License

[MIT](./LICENSE). Extracted from a production news pipeline and maintained as a
standalone, host-agnostic engine — contributions that keep it universal are
welcome (see [`CONTRIBUTING.md`](./CONTRIBUTING.md)).
