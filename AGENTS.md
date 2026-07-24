# AGENTS.md

Instructions for coding agents working in this repo, in the open
[agents.md](https://agents.md) format. Human contributors: see
[`CONTRIBUTING.md`](./CONTRIBUTING.md); adopters customizing the engine: see
[`CUSTOMIZING.md`](./CUSTOMIZING.md) and [`README.md`](./README.md).

## What this is

`ai-journalist` is a **domain-agnostic** blog-generation engine behind hexagonal
ports. Given a _signal_ ("what's happening"), it discovers a story, researches
it, writes it through an LLM + deterministic-gate chain, and emits a finished
post. The core imports **nothing** from a host app, ORM, or framework —
everything domain-specific is injected through the ports in
[`ports.ts`](./ports.ts). An AST purity guard enforces that boundary in CI.

## Component map

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

presets/          createDefaultInternals — a working EngineInternals from 4 inputs
presets/news-desk.ts        the opinion-desk preset (see below) — trending story → one columnist's op-ed
sources/          Http / Rss / File / compose — the reference Source library
sources/lead-image.ts       lead image: source og:image first, Openverse CC fallback
clients/          OpenRouter LlmClient + Firecrawl/SearXNG SearchClient (the reference clients)
testing/replay.ts record/replay harness (sha256-keyed) for deterministic tests
*.checks.ts       per-module byte-lock + behavioral checks (run by `npm run test:checks`)
examples/         runnable demos — basic.ts (offline) + live-minimal.ts (operator-run)
```

## Mechanical invariants — enforced, never loosen to make a change pass

Three checks gate every change. They are mechanical: a passing diff is one that
respects them, not one that edits them.

1. **Purity AST guard** — the core is `process.env`-free and carries no
   `owl-alpha` model-id literal or hardcoded brand literal (`Example News` /
   `example.com`). Enforced by an AST guard (inspects real literal/property nodes,
   never comments):

   ```
   npx tsx __guard.checks.ts
   ```

2. **Byte-locks** — the `*.checks.ts` pin the exact LLM prompts (catching prompt
   drift) plus per-module behavior. **Never loosen a lock to make it pass** — if a
   lock fails, the prompt/behavior changed; fix the change or update the lock
   deliberately with the reason.

   ```
   npm run test:checks
   ```

3. **Offline example** — `examples/basic.ts` runs the full discover → generate →
   publish flow with zero real services; it must stay green so the wiring never
   silently breaks.

   ```
   npm run test:example
   ```

## Where a change goes

- **New gate / edit pass** → `gates.ts` + its byte-lock in `gates.checks.ts`.
- **New Source** (data in) → `sources/` (implement the input `Source` port).
- **New search or LLM backend** → `clients/` (implement `SearchClient` /
  `LlmClient`; this is the only tree allowed to read `process.env`).
- **New default binding** (a batteries-included wiring) → `presets/`.
- **Domain enrichment** (first-party site inventory, entity links, jobs
  formatting) → a **host adapter** supplied through `PipelineEnrichment`
  (`pipeline.ts`). It **never** goes into the core — the core writes without it
  (`neutralEnrichment()`).

## Commands

| Command                    | What it does                                                     |
| -------------------------- | ---------------------------------------------------------------- |
| `npm run build`            | Type-check the whole tree (`tsc --noEmit`).                      |
| `npm test`                 | `test:checks` + `test:example` (everything CI runs).             |
| `npm run test:checks`      | AST purity guard + all `*.checks.ts` byte-locks (standalone tsx).|
| `npm run test:example`     | The offline end-to-end example under vitest.                     |

`examples/live-minimal.ts` is operator-run (`npx tsx examples/live-minimal.ts`),
NOT part of `npm test` — it makes live calls and prints `SKIP` without
`OPENROUTER_API_KEY`.

## The one hard rule

**The core may not read `process.env`; only `clients/**` may.** The core takes
all configuration as arguments (`EngineConfig`, `EngineInternals`, knobs); API
keys and backend selection live in the reference clients. The purity guard fails
CI on any `process.env` read outside `clients/**`.

## The news-desk preset (`presets/news-desk.ts`)

`createNewsDesk` is the opinion-desk wiring: it reads a trending list, resolves
which outlets carry the story, floors it on source count and content quality,
verifies a historical parallel, picks a lead image, and publishes.

**One take per story (2026-07-24).** The desk used to publish the same story
three times, once per columnist, off a neutral retell plus a labeled `Analysis`
section. It now publishes exactly one column: the caller passes a single
`persona`, and the columnist's own text *is* the article body. There is no
neutral retell any more. Do not reintroduce one — a reader seeing the same
headline three times was the bug this replaced. The random draw lives in
`examples/run-news-desk.ts` (`ROSTER` → `pickOne`), not in the preset, so the
preset stays deterministic and testable.

**The author-version contract** (`checkAuthorVersionContract`) is a hard gate,
not advice. A draft is rejected and re-attempted unless it:

- lands inside the word floor/cap (`authorVersions.wordCap`, default 600),
- attributes the reporting to **≥2 outlets by name**,
- names the verified historical parallel, and carries both
  `**Where the parallel breaks down:**` and `**The bottom line:**`,
- never mentions the encyclopedia — parallel verification is internal, and the
  reader never sees a Wikipedia line in `## Sources`,
- carries **2–5 `##` chapters, each with an original title** drawn from what
  that chapter argues. Generic labels (`Analysis`, `Context`, `Background`,
  `Conclusion`…) and headings naming the columnist are rejected by
  `GENERIC_HEADING_RE`.

Retries **revise the previous draft** rather than restarting. Independent
re-attempts oscillated — each new draft fixed one failure and broke another.

**Matching is typography- and case-insensitive** by construction: `namesEvent`
and `mentionsName` (in `gates.ts`) normalize en dashes and leading articles.
Both exist because exact matching produced false negatives that failed valid
drafts ("Smoot–Hawley" vs `Smoot-Hawley`, "the Dust Bowl" vs "The Dust Bowl").
Compare names through them, never with `includes` on raw text.

**Openverse AND-matches every term**, so `imageKeywords` caps a query at three
significant words and falls back 3 → 2 → 1. A full headline returns zero
results; verified live ("Ukraine general" = 240 hits, the full headline = 0).

## Verifying a change here

`npm run test:checks` — **trust the exit code, not a grep for `FAIL`.** A check
file that throws (rather than failing an assertion) prints `… failed: Error:`
and exits 1 without ever printing a `FAIL` line, and the runner stops there, so
the remaining files never run. Grepping the tail for `FAIL` reports a false
green on exactly the changes most likely to break something.

## Universality invariant (2026-07-08)

This engine is a UNIVERSAL, host-agnostic OSS package. Nothing
publication-specific ships in it: no host's domain framing, category taxonomy,
audience description, or signal phrasing in any prompt literal — identity
threads through `BrandProfile` (`desk` / `signalDescriptor` / `signalHeading` /
`audience` / `categories`) with neutral defaults. Before adding prompt text ask:
could a different publication ship this line unchanged? If not, it belongs in a
`BrandProfile` field. The AST guard (`__guard.checks.ts`) bans the phrases that
leaked once ("frontier-tech", "hiring publication", host brand names).
Host-specific optimizations belong in the host's adapter, never here.
