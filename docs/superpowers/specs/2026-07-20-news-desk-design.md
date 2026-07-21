# News Desk — design

**Date:** 2026-07-20 · **Status:** approved-pending-review · **Scope:** ai-journalist OSS repo

## Goal

A new pipeline path ("news desk") that: finds the currently trending news story,
aggregates every scrapable outlet's coverage of it, retells the essence with
per-outlet attribution (quotes, figures, dates preserved), and appends a
clearly-labeled **Analysis** section written from a configurable persona whose
method is: ground in the aggregated evidence (OSINT), name a *verified*
historical parallel, and state where the parallel breaks down.

Everything lands in the OSS repo as universal, opt-in machinery — no default
behavior changes for existing adopters. zerogtalent's production research
hardening is upstreamed as part of the work (its adapter migrates later, by
deletion, at its own pace, behind its golden test — nothing changes for it
until it bumps the npm dependency).

## Constraints (settled with the operator)

- **Model:** `gemma4:e4b` via Ollama on the Mac mini (LAN). No API models.
  Consequence: every LLM step is narrowed — one decision per call, always
  schema-constrained, evidence only from supplied context, examples in every
  prompt. The model labels, extracts, compresses, writes. It never searches,
  ranks, or invents structure. All ranking/counting/matching is mechanical.
- **Region:** US edition first (`hl=en-US&gl=US&ceid=US:en`). Worldwide later
  is config, not code: more feeds + more GN editions.
- **Output:** files (`out/<slug>.md`), DRAFT. Publishing sink deferred.
- **Provenance:** the runner wires the run-context artifact sink to
  `out/runs/<runId>/` — every search, scrape, match, and gate verdict lands
  on disk, so "what was this article based on" is always answerable.
- **Cadence:** manual runs v1; a launchd cron on the mini once quality
  settles (the whole stack already lives there). When cron lands, "exit
  non-zero, loudly" stops being enough (invisible under launchd — the
  production lesson: a dead run silently stops publishing for days). Cheap
  analogs of zerogtalent's alerting: flush run artifacts + the error to
  `out/runs/<runId>/` on failure, one `osascript` notification per failed
  run, and a small "list runs with gate blockers" summarizer over `out/runs/`.
- **Google search egress (hard rule):** if the SearXNG `google` engine is
  enabled for supplementary research, it MUST route through the Mac mini
  residential bridge via a per-engine proxy in `settings.yml` — the exact
  pattern zerogtalent already runs for DDG (`scripts/vps/searx-ddg-bridge`).
  Never hit Google from the VPS IP directly (captcha/block within queries).
  Optional ops task alongside Phase 1; the news desk itself does not depend
  on it (GN RSS is fetched directly; Wikipedia verification uses the
  existing wikipedia engine).
- **Scrapable outlets only:** the curated outlet feed list IS the scrape
  allowlist. Hosts that fail antibot land on a runtime skip-list.

## Trending: Google News RSS as the oracle (validated live 2026-07-20)

`https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en` (Top Stories; section
feeds exist for WORLD/NATION/etc.).

Validated facts the design relies on:

- Each `<item>` is a **pre-clustered story**: `<title>` = lead headline
  (` - <Outlet>` suffix), `<description>` contains an `<ol>` of related
  coverage — one `<a>` (headline) + `<font>` (outlet name) per covering outlet.
  Google's editorial+algorithmic rank replaces our own popularity scoring.
- Item `<link>`s are **JS-redirect stubs** — curl sees 200 with no Location;
  Firecrawl scrape returns 0 chars. **We do not decode them** (decoder libs
  exist but ride an internal Google endpoint; out of scope v1).

**Trending score v1** = GN feed position (primary) + coverage-list length
(tiebreak). Both parsed, zero LLM.

## URL resolution: match GN coverage to our own feeds

For each coverage entry (headline + outlet) in the winning GN story, find the
matching item in that outlet's own RSS feed (which we also ingest and which
carries the real article URL). Match = embedding similarity between headlines
(threshold knob), trigram fallback when no embedder is configured.

- Curated outlet feeds (v1, US-weighted, empirically scrapable — verified by a
  probe check at implementation time): AP, BBC, Guardian, Al Jazeera, NPR,
  Politico, The Hill, CNBC, DW, France24 — final list = whatever passes the
  probe, target 10–15. Config shape: `{url, outlet, region}`.
- Resolution matches the story against **every configured outlet's index**,
  not only the outlets GN's coverage list names — our feeds often carry the
  story even when GN's description omits them.
- A trending story with **< 3 resolved scrapable sources → skip to next GN
  story** (loudly logged). Never write thin.
- **Cross-run memory:** a covered-stories ledger (`out/covered.json`: slug,
  title, ISO date) feeds the engine's `coveredTopics` port; already-covered
  stories are skipped to the next trending one. Follow-up coverage of a
  covered story is the series feature — out of scope v1.
- **GN terms note:** the GN RSS copyright text scopes the feed to personal,
  non-commercial use — which is exactly this project's use (open-source
  tooling, private drafts). No blocker. Revisit the trending oracle
  (GDELT / direct feeds) only if this ever becomes a public outlet.

## Pipeline (one run = one story)

```
GN Top Stories RSS ──parse──▶ ranked pre-clustered stories
outlet feeds ──────ingest──▶ headline→URL index per outlet
        └─▶ resolve winning story's coverage → ≥3 real scrapable URLs
        └─▶ scrape each in full (Firecrawl, onlyMainContent)
        └─▶ chunked per-source extraction (facts/figures/dates/quotes,
            verbatim, attributed; ~24K chars per LLM call, full content
            always processed — proven pattern from 2026-07-20 runs)
        └─▶ RETELL on a FIXED template — What happened / The numbers &
            reactions / Context — the model fills sections, never designs
            them (extends the gemma-narrowing rule to structure);
            per-outlet attribution enforced; sources list appended
        └─▶ PARALLELS: gemma proposes 3–5 candidates {era, event, actors,
            claimed_similarity} → each verified against the official
            Wikipedia REST API (opensearch → page summary; keyless, no
            SearXNG/VPS in the core path) + evidence-overlap score → best
            wins; none survive → Analysis runs without a parallel, says so
        └─▶ OPINION: persona config writes Analysis under the contract
        └─▶ gates: existing chain on retell; analysis profile on opinion
        └─▶ out/<slug>.md [DRAFT]
```

## The opinion contract

`PersonaProfile = { name, method, priors, voice }` — plain config, three
neutral examples ship: **Historian**, **Realist** (incentives & power),
**Systems thinker**. The analysis gate rejects the section unless it:

1. cites ≥ 2 facts from the aggregated evidence, by outlet;
2. names the verified historical parallel (or states none survived);
3. states where the parallel breaks down;
4. is labeled `Analysis — <persona name>` (persona = byline).

Fact-guard still applies to factual claims inside the analysis. Persona is
experimentation-by-config: same story, different persona file, rerun.

## Modules (all new files unless noted)

| File | Role |
| --- | --- |
| `sources/google-news.ts` | GN RSS → ranked `TrendingStory[]` — EXTENDS engine `news.ts` (it already owns the GN URL shape, the `<source>`→`sourceName` rss-parser customField, and title parsing); this module adds edition/topic feeds + the `<description>` `<ol>` coverage parsing only |
| `sources/newswire.ts` | multi-feed outlet RSS with `{url, outlet, region}` config; headline→URL index. **Must NOT inherit `sources/rss.ts`'s fetch pattern** (serial loop, rss-parser's 60s default timeout, one dead feed throws the whole signal — with 10–15 feeds that's the slowest, most fragile step): parallel via p-limit, per-feed best-effort with loud logging, explicit 15s timeout (the pattern `news.ts` already uses) |
| `matching.ts` | headline similarity (embedder w/ trigram fallback); pure |
| `research.ts` | upstreamed zerogtalent stack: sanitizeQuery/relaxQuery, throttled search + breaker, source tiering, primary chase, antibot skip-list; + the generalized chunked page-extractor |
| `parallels.ts` | propose → verify (official Wikipedia REST API) → select |
| `gates.ts` (extend) | analysis gate profile (contract above) |
| `presets/news-desk.ts` | wires everything; persona type + examples |
| `clients/ollama-embedder.ts` | `Embedder` port via the official `ollama` npm client (mini pulls `embeddinggemma`, ~622 MB — 2025-class quality, multilingual for worldwide v2) |
| `examples/run-news-desk.ts` | operator runner (files sink, mini Ollama) |
| `ports.ts` (extend) | optional `outlet` on `SignalItem`; `PersonaProfile` |

Existing seams reused: `gatherResearch` override (added 2026-07-20),
`Embedder` port, `coveredTopics`, gate chain, chunked extractor pattern,
`clients/ollama-llm.ts`.

## Dependencies (audited 2026-07-20; reuse over hand-rolling)

**New in v1:** `ollama` (official JS client — embedder; LLM adapter refactor
optional), `cheerio` (GN description `<ol>` parsing + entity decoding).
**Fallback tier:** `defuddle` — plain-fetch extraction when Firecrawl fails
on an outlet serving ordinary HTML; actively maintained (Obsidian Web
Clipper), multi-pass recovery, native Markdown output matching Firecrawl's
(same content-quality floor). Conservative alternative if it misbehaves:
`@mozilla/readability` + `linkedom` (huge install base, barely maintained). **Infra option (v1.5):** self-hosted RSSHub if the
scrapability probe leaves the outlet set thin.
**No new dep needed:** Wikipedia REST API (keyless fetch), cosine similarity
(pure math), GN RSS (standard RSS 2.0 → existing `rss-parser`).
**Rejected:** GN URL-decoder packages (low-adoption, internal-endpoint-
dependent), GN wrapper npms, string-similarity libs (embeddings + existing
trigram), node-cron (launchd), `ollama-helpers` (YAGNI at this volume).

## Upstreaming plan (zero risk to zerogtalent)

1. **Phase 1:** `research.ts` + seams land in the engine; defaults unchanged;
   minor version publish. (Sanitizer/tiering/chase/breaker are already
   domain-neutral in `services/blog/generator/generate.ts` — extraction is
   mostly a move.)
2. **Phase 2:** news-desk modules + preset; another minor version.
3. **Phase 3 (whenever):** zerogtalent PR swaps its local research stack for
   engine imports, gated by its golden test + draft-mode live runs. Until that
   dependency bump, production is untouched by construction.

Host-coupled machinery is NOT upstreamed as implementation — only interfaces
(performance-note input, coverage via existing `coveredTopics`).

## Failure handling

- Scrape failure → skip that outlet, log, continue; < 3 surviving sources →
  abort story, take next GN story; 0 stories survive → exit non-zero, loudly.
- **Content-quality floor:** a "successful" scrape below a min-length knob or
  matching paywall/teaser markers ("subscribe to read", etc.) is demoted to
  skipped — stub pages must not enter the evidence corpus.
- Antibot failures append to the runtime skip-list (in-run; persisted list is
  a knob).
- Search breaker (from zerogtalent) guards the SearXNG/Wikipedia path.
- No parallel survives verification → Analysis without parallel, labeled.
- Empty LLM completions throw (retryable) — existing client behavior.

## Testing

- `*.checks.ts` per new module, repo convention (offline, mocked fetch —
  same style as `clients/ollama-llm.checks.ts`):
  - `google-news`: fixture RSS → stories/coverage parsed, rank preserved
  - `newswire`: fixture feeds → index; outlet threading
  - `matching`: known headline pairs above/below threshold; trigram fallback
  - `research`: sanitizer cases (incl. the interrogative/dictionary-junk
    class), breaker, tiering order
  - `parallels`: mocked search — verify/select/none-survive paths
  - `gates`: analysis contract accept/reject fixtures
  - preset: offline wiring proof (basic.ts pattern)
- Feed probe script (implementation-time): scrape one article per candidate
  outlet through the operator's Firecrawl; the passing set becomes the v1
  example config.
- **Acceptance:** one live mini run producing a story with ≥ 3 attributed
  outlets, verbatim quotes + figures in the retell, and a verified (or
  honestly-absent) parallel in the Analysis.

## Out of scope v1

GN link decoding; non-US GN editions; non-English feeds; publishing sink;
series/continuity; per-persona A/B automation; GDELT/Wikipedia-pageview trend
oracles (natural v2 signal feeds).
