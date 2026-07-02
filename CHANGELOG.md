# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.2.0
[0.1.0]: https://github.com/mishafyi/ai-journalist/releases/tag/v0.1.0
