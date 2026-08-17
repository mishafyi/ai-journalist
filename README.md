# AI Journalist

[![npm](https://img.shields.io/npm/v/ai-journalist.svg)](https://www.npmjs.com/package/ai-journalist)
[![CI](https://github.com/mishafyi/ai-journalist/actions/workflows/ci.yml/badge.svg)](https://github.com/mishafyi/ai-journalist/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](https://nodejs.org)

**Point it at a data signal. Get back a researched, fact-checked, edited
article — or a hard failure naming the rule it couldn't meet.**

Most "AI writes your blog" tools are a prompt in a trench coat. Ask one for an
article and it will happily invent a source, a statistic, and a person who said
it. This is the other thing: the machinery a newsroom actually runs on.
Discover a story, research it across the web, write it section by section
against the evidence, then put the draft through an editor and a fact-integrity
gate chain before a word ships.

## The part worth caring about

**The article has to pass a contract, or the run fails.** Not a vibe check — a
mechanical one: at least 300 words, at least two outlets named in the prose, a
verified historical parallel named (or an explicit sentence saying there isn't
one), two to five chapters. Miss it and the desk rewrites and re-checks; miss it
after every attempt and the run throws. Most generators cannot fail. This one
can, on purpose.

**It refuses to persist a broken article.** If the body comes out render-broken,
or isn't article-shaped once the gates are done with it, the pipeline throws
instead of writing it anywhere.

**Fabrication gets deleted, not reworded.** A dedicated pass hunts invented
people — including the unnamed composite, the *"a 26-year-old researcher at…"*
who never existed — and invented scenes narrated with convincing specifics. Not
"please don't hallucinate" in a system prompt. A pass that cuts.

**The guardrails are deterministic.** Repetition budgets, figure-grounding
checks, attribution budgets, length-ratio guards. Models drift. The gates don't.

Afterwards, a fact-check audit rates every claim against the research —
`FOUND`, `DERIVABLE`, or `NOT FOUND` — and files the table with the run. That
one is advisory by design: it replaced a hard gate that kept killing good
articles because it couldn't tell a derived total from a fabrication.

**659 checks, and the prompts are byte-locked.** Change a prompt's wording and a
test fails — prompt drift is a red build, not a Tuesday-morning mystery. An AST
guard fails CI on any `process.env` read or hardcoded brand literal in the core,
so "domain-agnostic" is enforced rather than asserted.

Extracted from a newspaper that publishes on it daily.

## Install

```bash
npm i ai-journalist
```

Node 20+, ESM, ships as TypeScript source — consume it via `tsx` or your own
bundler.

## Quickstart

Bring four things — your data (`Source`), a model, a search backend, and who you
are. The preset assembles the rest.

```ts
import { runPipeline } from "ai-journalist";
import { createDefaultInternals } from "ai-journalist/presets";
import { createHttpSource } from "ai-journalist/sources";
import { createOpenRouterLlm } from "ai-journalist/clients/openrouter-llm";
import { createFirecrawlSearch } from "ai-journalist/clients/firecrawl-search";

const source = createHttpSource({ signalUrl: "https://my-api/signal" });
const llm = createOpenRouterLlm({});
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

Run [`examples/basic.ts`](./examples/basic.ts) to see it work with zero API keys
— it is also the CI wiring proof. [`examples/live-minimal.ts`](./examples/live-minimal.ts)
is the same run against a real model and search, and prints `SKIP` rather than
failing if you have no keys.

## The contract

[`ports.ts`](./ports.ts) is the whole customization surface. Four ports:

| Port           | You decide                                                        |
| -------------- | ----------------------------------------------------------------- |
| `Source`       | Where the signal comes from (`Http`/`Rss`/`File` ship, or your own) |
| `Sink`         | Where finished posts land — one `publish(post)` function           |
| `EngineConfig` | Model, search backend, brand voice, ~70 documented knobs           |
| `Linker`       | Optional on-site entity links                                      |

Swap the model (OpenRouter, Ollama, Google AI), the search backend (Firecrawl,
SearXNG, your own), or how photos are chosen — nothing is baked in.

**→ [`CUSTOMIZING.md`](./CUSTOMIZING.md) maps every seam, one runnable snippet
each.**

## Docs

| | |
| --- | --- |
| [`CUSTOMIZING.md`](./CUSTOMIZING.md) | "I want to change X" → the exact seam |
| [`AGENTS.md`](./AGENTS.md) | Component map and the invariants you must not loosen |
| [`CHANGELOG.md`](./CHANGELOG.md) | Semver, a section per version |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Contributions that keep it universal are welcome |

## License

[MIT](./LICENSE).
