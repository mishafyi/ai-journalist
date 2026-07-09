# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.8.2

- Discovery query-gen prompt: operator guidance inverted — plain natural-language
  queries, at most ONE quoted phrase, no site:/intitle:/negations. The old
  "use operators where they sharpen" line produced operator-stuffed queries that
  zero out on DDG-class search backends (measured: whole discovery rounds
  returned no signal), while plain queries hit.

## 0.8.1

- `GateDeps.auditInputChars?` (default 120000) — runFactCheckAudit's ground-truth
  slice is now host-configurable. A 2026-07-09 containment audit of a live run
  found a 490K-char corpus sliced to 120K (~24%), with the corpus assembled
  research-first — so first-party data and late-section material sat exactly in
  the cut-off region, rating well-grounded claims NOT FOUND and inflating
  audit-forced DRAFTs.
- The audit call now receives the pool FIRST-PARTY-FIRST (board truth + gov data
  ahead of web research) so the highest-authority ground truth is always inside
  the audit window. Fact-guard keeps the unsliced pool (order irrelevant there).

## 0.8.0

- **Universality: publication identity fully externalized.** The last
  host-flavored prompt literals (a "frontier-tech hiring publication" desk
  line, a job-board signal descriptor, an audience list, and a hardcoded
  story-category taxonomy) now thread through new optional `BrandProfile`
  fields — `desk`, `signalDescriptor`, `signalHeading`, `audience`,
  `categories` — resolved to neutral, `beat`-derived defaults by the preset.
  The AST purity guard now bans the phrases that leaked ("frontier-tech",
  "hiring publication", host brand names), and AGENTS.md carries the standing
  invariant: if a different publication couldn't ship a prompt line unchanged,
  it belongs in `BrandProfile`.
- Publish workflow now creates a GitHub Release (with the version's CHANGELOG
  section) for every npm publish — npm and GitHub stay in lockstep from the
  same tag.
- README rewritten: value-first, current npm install (the "not yet published"
  note was stale), compact quickstart.

## 0.7.5

- runTitle membership gate: the structured `{candidates, best}` schema
  guarantees shape, not semantics — a model returned `best: "candidate_2"`
  (a reference into its own list, not the verbatim text) and it published as a
  live title (2026-07-08). "best" now must be one of the candidates: numeric
  references resolve against the list, anything else falls back to the first
  candidate, and the swap is recorded in the title gate trace
  (`best-not-in-candidates`).

## 0.7.4

- runEdit: the "cut about 10%" instruction is GONE — models read any percentage
  as license to condense (measured 43–54% keeps). The pass now cuts only what
  the craft bullets name (line-fat, repetition, filler) and states it is a line
  edit, not a condensation; the editWordFloor stays as the guardrail.
- Section write prompt: the word target is now a floor, not a range —
  "at least min words (max is a guide, not a ceiling — run past it whenever the
  grounded material supports more)". Sections should never be capped by prompt
  when the reporting supports depth.

## 0.7.3

- `GateDeps.editWordFloor?` (default 1200) — runEdit/runFinalEdit prompts now
  carry an explicit word floor. "cut about 10%" alone measured 43–54% keeps and
  the "surgical" final read ~55% (2026-07-08); with fact-guard stripping ~30%
  after them, finals fell under the pipeline's 800-word shape assertion even
  with in-target sections. Fact-guard deliberately gets NO floor — integrity
  strips must never be traded for length.

## 0.7.2

- `SectionWriterDeps.sectionWordTarget?: { min, max }` (default 350–550) — the section
  write prompt now carries an explicit numeric length target (main instruction +
  restated block). Without one, section length tracked evidence volume: Part C's
  digest-composed prompts (~1.5k chars of extractive spans vs ~6–10k raw research)
  halved sections and final bodies fell under the pipeline's 800-word shape floor —
  every 2026-07-08 run ended `Final body is not article-shaped` (337–652 words).
  Digest-active prompts additionally say the digests are compressed evidence to
  reconstruct from, not a brevity model to mirror.

## [0.7.1] - 2026-07-08

### Added

- **Deterministic editorial gates (Part D, record-only pure functions in
  `gates.ts`).** `corroborationBlockers(article, rawCorpus)` — every figure in
  the H1 + first three paragraphs needs ≥2 independent source domains OR
  first-party board data (years and sub-10 figures skipped).
  `structureBlockers(article, theme, opts?)` — early-nut presence via
  trigramSimilarity (default threshold 0.18, calibrated), cluttered-lead
  (≥3 numbers in the opening paragraph), and load-bearing-ending (a figure
  appearing only in the final two paragraphs).
- **`GateDeps.seoInputChars` (Part E1):** `runSeo` reads up to this many
  article chars (default 24000; was a hard-coded 6000 slice), so SEO metadata
  sees the whole piece, not just the lede.

## [0.7.0] - 2026-07-08

### Added

- **Research-digest architecture (Part C engine half: C1/C2/C4).**
  - `digest.ts`: `buildDigest(raw, label, deps)` — extractive six-box research
    index (HISTORY/SCOPE/REASONS/IMPACTS/COUNTERMOVES/FUTURES) of verbatim
    spans + URL + normalized date; instructions restated after the payload.
  - Optional `SectionWriterDeps` fields `generalDigest` / `digestSection` /
    `retryThin` and `DiscoveryDeps.onCorpus`: when active, section prompts
    compose MAIN THEME → plan → general digest (background) → section digest
    (primary grounding) → board data → restatement; thin sections call
    `retryThin` before the qualitative fallback; the RAW research always pools
    for the guards. Absent deps ⇒ byte-identical legacy behavior.
  - `recastTheme(theme, generalDigest, deps)`: structured (schema-constrained)
    post-research theme recast with keep/adjust/kill verdicts +
    `newestSourceDate`; staleness (`stale-story: …`) and `theme-killed`
    warnings flow through the existing gate-warnings channel; kill throws for
    the host's fail-soft. Window/now/ctx arrive via optional deps
    (`maxStoryAgeDays` default 14) — the engine still reads no env.

## [0.6.1] - 2026-07-07

### Added

- **Main theme statement lifecycle (Part B).** `Plan` gains optional
  `themeStatement` (1-2 action sentences of what the story SAYS), produced by
  the plan prompts; `themeOf(plan)` is the single accessor (falls back to
  `title — angle`, so pre-0.6.1 plans/fixtures stay valid). The theme is
  threaded as a MAIN THEME anchor into the section-writer prompt (+ a
  serve-the-theme line in the restatement block) and, via the new optional
  `GateDeps.theme`, into the managing-editor (with an early-nut rule) ,
  fact-guard, and headline prompts. Prompt/schema additions only — no
  breaking API changes.

## [0.6.0] - 2026-07-07

### Changed

- **Editorial prompt mechanics (Part A of the editorial-pipeline upgrade).**
  Long-context prompts now restate the task AFTER the data payload
  (section-writer, fact-guard, fact-check-audit — lost-in-the-middle
  mitigation), with a recency rule (prefer the newest dated source,
  date-qualify older claims). Section 1 gains lead-craft rules; the line-edit
  pass teaches pictorial numbers, blob-hunting, abstract↔concrete movement,
  and surface-and-conclude; the managing-editor pass gains character economy,
  proof variety, natural transitions, and the three newspaper close types
  (no unique load-bearing facts in the kicker). Discovery: queries spread
  across the six story boxes with the five ideation techniques
  (extrapolate/synthesize/localize/project/switch-viewpoint); story-plan
  demands a cause-and-effect map with an explicit fence, a deliberate
  roundup-vs-profile approach choice, and block-progression section ordering.
  The audit pass appends a "MISSING:" completeness line. Prompt-text only —
  no API changes.

## [0.5.2] - 2026-07-07

### Changed

- Release-infrastructure validation: first release published via npm
  **trusted publishing** (OIDC from GitHub Actions, tokenless). No code
  changes.

## [0.5.1] - 2026-07-06

### Added

- **`LlmCallStat`: optional `model` + `generationId` fields for adapter-side
  per-call provenance.** `model` is the model id that served the successful call
  (as reported by the provider response); `generationId` is the provider's
  generation id (OpenRouter `response.id`), joinable to
  `GET /api/v1/generation` for per-call provider-side metadata. Both are
  optional — existing callers passing the base
  `{label, attempts, ms, promptTokens, completionTokens}` set remain type-valid
  with zero changes.

## [0.5.0] - 2026-07-04

### Added

- **9 deep-import subpaths + the headline corpus asset in `exports`.** Added
  `./gates`, `./discovery`, `./section-writer`, `./assembly`, `./run-context`,
  `./text`, `./news`, `./primitives`, `./gate`, and the `./headlines.json` asset
  to the `exports` map. The files already shipped in the tarball (via
  `files: ["*.ts", "*.json"]`) but were not addressable as package subpaths, so a
  rich host that hand-builds `EngineInternals` (rather than using
  `createDefaultInternals`) could not import the gate/discovery/section-writer
  types and helpers it needs. This unblocks a first-party consumer that imports
  the engine's internals directly.
- **Publish-on-tag GitHub Action (`.github/workflows/publish.yml`).** Pushing a
  `v*` tag runs `npm publish` (needs an `NPM_TOKEN` repo secret). The package
  ships raw `.ts` with no build step, so publish just packs.

### Changed

- **First-party board data is now the PREFERRED source for a figure it carries.**
  Generalized the section-writer's `FIRST-PARTY BOARD DATA` prompt from
  "cite ONE figure if relevant, otherwise omit" to: PREFER a first-party board
  figure over any web-scraped second-hand report of the same figure, and cite the
  specific board item by name. The fact-guard's `TABLE-CELL attribution` rule
  gains a matching EXCEPTION — a table cell whose figure is present in the
  `FIRST-PARTY BOARD DATA` block is authoritative and preferred over any
  web-scraped figure for that entity. Both stay domain-agnostic (figure-generic,
  not tied to any one content vertical). Byte-locked in `gates.checks.ts`.

## [0.4.2] - 2026-07-03

### Changed

- **Set the SDK timeout ONCE at client construction, not per-call.** The
  `@openrouter/sdk` resolves a request's timeout as `options?.timeoutMs ||
  client._options.timeoutMs || -1`, so a client-level `SDKOptions.timeoutMs`
  (set in the two `new OpenRouter({...})` constructors) is inherited by every
  `chat.send`, and the two calls return to the documented single-arg
  `{ chatRequest }` envelope. Same env knob (`OPENROUTER_CALL_TIMEOUT_MS`, 120s
  default) and behaviour as 0.4.1 — just DRYer, and it covers any future call
  site automatically instead of relying on each one to pass the option.

## [0.4.1] - 2026-07-03

### Changed

- **Use the SDK's native per-call `timeoutMs` instead of a hand-rolled
  `Promise.race`.** `@openrouter/sdk`'s `chat.send(request, { timeoutMs })`
  (`RequestOptions`) turns the value into an `AbortSignal.timeout` on the
  underlying `fetch` (`lib/sdks`), so a timed-out call ABORTS the request and
  releases the socket — where the 0.4.0 `Promise.race` wrapper left the hung
  `fetch` reading in the background (a socket leak plus the later floating
  rejection). Same env knob (`OPENROUTER_CALL_TIMEOUT_MS`, default 120s) and the
  same per-model retry/advance behaviour; strictly cleaner teardown of a hung
  free-model call, and no longer hand-rolls what the SDK provides.

## [0.4.0] - 2026-07-03

### Fixed

- **Bounded a hang on the OpenRouter free-tier.** `@openrouter/sdk`'s response
  matcher `JSON.parse`s the body with no empty-body guard (still true in the
  latest `0.13.22`), so an intermittently-empty free-provider response throws a
  *floating* rejection while the awaited `chat.send` never settles — hanging the
  whole pipeline. `createOpenRouterLlm` now wraps every `chat.send` in a hard
  per-call timeout (`OPENROUTER_CALL_TIMEOUT_MS`, default 120s): on timeout the
  call rejects, so the per-model retry advances to the next ranked free model
  instead of hanging. No behavior change on the happy path.

## [0.3.0] - 2026-07-02

### Added

- `DefaultInternalsOptions.embedder?` (`ai-journalist/presets`) — pass any
  `Embedder` (`ports.ts`) and `createDefaultInternals` upgrades its
  `embedDedupSurvivors` from the trigram-only `null` fallback to real
  embedding-grade near-paraphrase dedup (cosine over a per-factory cache),
  bound into both the discovery topic pass and the title-candidate gate.
  Omitted → today's `null` behavior, unchanged.

## [0.2.0] - 2026-07-02

### Added

- `createDefaultInternals()` (`ai-journalist/presets`) — a complete, working
  `EngineInternals` from four inputs (`llm`, `search`, `brand`, `source`);
  binds the REAL gate chain, proven by an offline full-pipeline check.
- `presets/text-defaults.ts` — generic pure text/format helpers for
  `PipelineDeps` (host-free defaults).
- `createSearxngSearch()` (`ai-journalist/clients/searxng-search`) — SearXNG
  reference `SearchClient`.
- Docs: `AGENTS.md` (agents.md format), `CUSTOMIZING.md` (the decision table),
  `examples/live-minimal.ts` (real-Phase-2 live example); README quick-start
  rewritten around the preset.

### Changed

- **Breaking:** the 12 domain functions + `linkNameStoplist` + 6 knobs moved
  off `PipelineDeps` into the optional `PipelineEnrichment` group
  (`enrichment?:`); omitted → `neutralEnrichment()` and the core pipeline
  writes with zero domain data. Full-enrichment callers are byte-identical,
  except the first-party site-inventory ground-truth block is now omitted when
  site data is all-zeros (previously injected a false "0 open roles" fact).
- `@openrouter/sdk` dynamic model selection ships in the default preset
  (`model` omitted → top-weekly free ranking).

## [0.1.0] - 2026-06-19

Initial public release — extracted engine, ports contract, reference
sources/clients, byte-lock + purity CI.

[0.5.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.5.0
[0.4.2]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.4.2
[0.4.1]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.4.1
[0.4.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.4.0
[0.3.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.3.0
[0.2.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.2.0
[0.1.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.1.0
