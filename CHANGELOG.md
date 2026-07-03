# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.4.2]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.4.2
[0.4.1]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.4.1
[0.4.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.4.0
[0.3.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.3.0
[0.2.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.2.0
[0.1.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.1.0
