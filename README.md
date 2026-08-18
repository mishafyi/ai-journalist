# AI Journalist

[![npm](https://img.shields.io/npm/v/ai-journalist.svg)](https://www.npmjs.com/package/ai-journalist)
[![CI](https://github.com/mishafyi/ai-journalist/actions/workflows/ci.yml/badge.svg)](https://github.com/mishafyi/ai-journalist/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](https://nodejs.org)

**Give it your data. Get back a real article — researched, fact-checked, and
edited — or a clear failure explaining why it wouldn't publish one.**

You have something that knows what's happening in your world: a database of new
listings, an RSS feed, an API, a spreadsheet of this week's numbers. This turns
that into a written story. It picks what's worth covering, researches it across
the web, writes it, then puts the draft through an editor and a set of
fact-integrity checks before handing it back.

## Try it in two minutes

```bash
npm i ai-journalist
npx ai-journalist init          # pick a model + search backend, once
npx ai-journalist write signal.json
```

`init` writes a starter `signal.json`. Your data goes in it, and it's just a
list of things that happened:

```json
{
  "framing": "climate-tech funding, last 24h",
  "items": [
    {
      "title": "Acme raises $40M",
      "summary": "Series B for direct-air capture, led by Breakthrough Energy.",
      "entities": ["Acme", "Breakthrough Energy"],
      "date": "2026-08-17",
      "url": "https://example.com/the-source"
    }
  ]
}
```

Only `title`, `summary` and `entities` are required. Most people produce this
with one `map()` over data they already have.

Not sure your file is right? `npx ai-journalist check signal.json` tells you,
for free, without calling a model.

You can also point it straight at data you already publish — no file needed:

```bash
npx ai-journalist write https://example.com/feed.xml     # an RSS feed
npx ai-journalist write https://my-api.example.com/signal # a JSON endpoint
```

## What it needs

Two things: a **model** to write with, and a **web search** to research with.
Both have a free option, and `init` walks you through picking:

|            | Paid, quickest to start | Free, runs on your own machine        |
| ---------- | ----------------------- | ------------------------------------- |
| **Model**  | OpenRouter              | [Ollama](https://ollama.com)          |
| **Search** | Firecrawl               | [SearXNG](https://github.com/searxng/searxng) |

## From your own code

The CLI is a thin wrapper over one function — anything it does, your app can do:

```ts
import { writeArticle } from "ai-journalist";

const { markdown, title } = await writeArticle({
  from: "./signal.json",       // items, a file, a URL, a feed, or your own Source
  brand: { name: "My Outlet", beat: "climate tech" },
  llm, search,                 // or: llmFromEnv(), searchFromEnv()
});
```

Nothing is published — you get the markdown and decide what to do with it.

## Why not just ask a chatbot

Ask one for an article and it will cheerfully invent a source, a statistic, and
a person who said it. The machinery here is the difference:

- **It can fail.** The article has to clear a mechanical contract — a length
  floor, at least two outlets named in the prose, a verified historical parallel
  or an explicit sentence saying there isn't one. Miss it and the desk rewrites;
  miss it every time and the run throws. Most generators cannot fail. This one
  can, deliberately.
- **Fabrication gets deleted, not softened.** A dedicated pass hunts invented
  people — including the unnamed composite, the _"a 26-year-old researcher
  at…"_ who never existed — and invented scenes narrated with convincing
  detail. Not a "please don't hallucinate" instruction. A pass that cuts.
- **It won't save a broken article.** If the result isn't article-shaped once
  the checks are done, the pipeline throws instead of writing it anywhere.
- **The guardrails are deterministic.** Repetition budgets, figure-grounding,
  attribution budgets, length-ratio guards. Models drift. The gates don't.
- **Numbers can come from primary sources.** Point it at a
  [DataGod](https://github.com/mishafyi/datagod) instance and it decides, per
  story, whether hard data would sharpen the piece — then fetches from FRED,
  USAspending, SEC EDGAR, Treasury, World Bank, USGS and more. Series IDs are
  whitelisted, so the model picks from a menu instead of inventing one.
- **Everything is auditable.** Every prompt, response, search and gate verdict
  is recorded per run.

Afterwards a fact-check audit rates every claim against the research —
`FOUND`, `DERIVABLE`, or `NOT FOUND` — and files the table with the run.

Extracted from a newspaper that publishes on it daily. 659 checks, and the
prompts are byte-locked: change a prompt's wording and a test fails.

## Going further

Everything above uses defaults. When you outgrow them, four typed seams let you
replace any part without forking:

| Port           | You decide                                                          |
| -------------- | ------------------------------------------------------------------- |
| `Source`       | Where the data comes from (`File`/`Http`/`Rss` ship, or write one)  |
| `Sink`         | Where finished articles land — one `publish(post)` function          |
| `EngineConfig` | Model, search backend, brand voice, ~70 documented knobs             |
| `Linker`       | Optional on-site entity links                                        |

Swap the model, the search backend, or how photos are chosen — nothing is baked
in. `runPipeline()` is the full contract when you want to drive it yourself;
[`ports.ts`](./ports.ts) is the whole surface, and
**[`CUSTOMIZING.md`](./CUSTOMIZING.md) maps every seam with a runnable snippet.**

The engine imports nothing from any host app, and an AST guard fails CI on any
`process.env` read or hardcoded brand name in its core — so "works for anyone's
data" is enforced, not just claimed.

## Install notes

Node 20+, ESM, ships as TypeScript source — consume it via `tsx` or your own
bundler. The CLI needs `tsx`, which installs automatically as an optional
dependency; skip it with `--omit=optional` if you only use the library.

## Docs

|                                          |                                                     |
| ---------------------------------------- | --------------------------------------------------- |
| [`CUSTOMIZING.md`](./CUSTOMIZING.md)     | "I want to change X" → the exact seam                |
| [`examples/`](./examples)                | `basic.ts` runs offline with zero keys               |
| [`AGENTS.md`](./AGENTS.md)               | Component map and the invariants not to loosen       |
| [`CHANGELOG.md`](./CHANGELOG.md)         | Semver, a section per version                        |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)   | Contributions that keep it universal are welcome     |

## License

[MIT](./LICENSE).
