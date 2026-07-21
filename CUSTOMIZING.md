# Customizing the engine

Every knob is an argument, not a fork. This is the map from "I want to change
X" to the exact seam that changes it. The authoritative reference is
[`ports.ts`](./ports.ts) (the contract) and [`presets/default.ts`](./presets/default.ts)
(`createDefaultInternals`, which turns four ports into a running pipeline); this
page is the guided tour.

## Decision table

| I want to change…                    | Change this                                       | Where                                       |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------- |
| WHERE content comes from             | a `Source` (config or a custom impl)              | `sources/` · `ports.ts`                     |
| WHERE finished posts land            | `Sink.publish`                                     | your code · `ports.ts`                      |
| WHAT model writes                    | `createOpenRouterLlm({ defaultModel })` / `LlmClient` | `clients/openrouter-llm.ts`             |
| HOW research happens                 | a `SearchClient` (Firecrawl / SearXNG / custom)   | `clients/` · `ports.ts`                     |
| WHAT the writing sounds like         | `systemPrompt` + `BrandProfile`                   | `presets/default.ts` · `ports.ts`           |
| HOW MUCH it writes                   | `knobs`                                            | `presets/default.ts` (`DefaultKnobs`)       |
| PARAPHRASE-grade dedup               | pass `embedder` (any `Embedder`; e.g. an HTTP wrapper over your embedding service) | `presets/default.ts` · `ports.ts`           |
| DOMAIN data woven in                 | `PipelineEnrichment`                              | `pipeline.ts`                               |
| OBSERVABILITY                        | `onEvent` / `onError` / `RunContext`              | `presets/default.ts` · `run-context.ts`     |

Each row below carries a runnable snippet. They all assume the preset:
`createDefaultInternals({ llm, search, brand, source })` returns the
`EngineInternals` you hand to `runPipeline`.

---

## WHERE content comes from → `Source`

The input `Source` is "what to write about". Three layers of effort — the common
cases are **config, not code**:

| Layer | You bring                                                                                       | Engine code             |
| ----- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| 1     | An endpoint returning `DiscoverySignal`/`GroundingFacts` → `HttpSource({signalUrl, factsUrl})` | none                    |
| 2     | Any endpoint + a `mapSignal: (raw) => DiscoverySignal`                                          | none                    |
| 3     | A custom `Source` (DB / file / scrape)                                                          | implement one interface |

Layer 1 — point a reference source at a conforming endpoint:

```ts
import { createHttpSource } from "ai-journalist/sources";

const source = createHttpSource({ signalUrl: "https://my-api/signal" });
```

Layer 3 — implement `Source` directly (one required method: `gatherSignal`;
`gatherFacts` and `coveredTopics` are optional):

```ts
import type { Source, DiscoverySignal } from "ai-journalist/ports";

const source: Source = {
  async gatherSignal(): Promise<DiscoverySignal> {
    const rows = await db.freshHirers(); // your query
    return {
      framing: "space/AI hiring, last 24h",
      items: rows.map((r) => ({
        title: r.headline,
        summary: `${r.industry} · ${r.roleCount} open roles`,
        entities: [r.company],
        weight: r.roleCount,
      })),
    };
  },
};
```

## WHERE finished posts land → `Sink.publish`

There is **no Sink class to subclass** — the Sink is any object with a
`publish(post)` method. It is the one port you always implement (a file, a CMS,
your API):

```ts
import type { Sink, GeneratedPost, PublishResult } from "ai-journalist/ports";

const sink: Sink = {
  async publish(post: GeneratedPost): Promise<PublishResult> {
    await cms.createDraft({ slug: post.slug, title: post.title, body: post.markdown });
    return { url: `https://mysite/blog/${post.slug}`, status: "DRAFT" };
  },
};
```

## WHAT model writes → `createOpenRouterLlm` / any `LlmClient`

The reference client wraps OpenRouter. Two behaviors:

- **omit `defaultModel`** → DYNAMIC selection: the client picks the current
  top-weekly free OpenRouter model at runtime (and advances past any that gets
  delisted or exhausted).
- **pass `defaultModel`** → pins that id (deterministic).

```ts
import { createOpenRouterLlm, DEFAULT_MODEL } from "ai-journalist/clients/openrouter-llm";

// Pinned, deterministic:
const llm = createOpenRouterLlm({
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultModel: DEFAULT_MODEL,
});

// Dynamic (omit defaultModel):
const auto = createOpenRouterLlm({ apiKey: process.env.OPENROUTER_API_KEY });
```

Any provider works — implement the `LlmClient` port (`complete` +
`completeStructured`) and pass it as `llm`. The engine already depends on Zod, so
`completeStructured` receives the schema as a `ZodType` and must return the typed
object (use your provider's native `response_format: json_schema`).

## HOW research happens → `SearchClient`

Search is fully swappable. The engine ships two reference clients; either (or
your own) satisfies the `SearchClient` port:

```ts
// Firecrawl (apiUrl required — pass it or set FIRECRAWL_API_URL):
import { createFirecrawlSearch } from "ai-journalist/clients/firecrawl-search";
const fc = createFirecrawlSearch({
  apiKey: process.env.FIRECRAWL_API_KEY,
  apiUrl: process.env.FIRECRAWL_API_URL,
});

// SearXNG (a separate self-hosted metasearch, NOT a Firecrawl backend):
import { createSearxngSearch } from "ai-journalist/clients/searxng-search";
const sx = createSearxngSearch({
  baseUrl: process.env.SEARXNG_URL, // or pass { engines, language, timeoutMs }
});
```

A custom `SearchClient` is one method — `search(query, { limit })` returning
`{ title, url, snippet }[]` (an optional `scrape(url)` enables full-page grounding):

```ts
import type { SearchClient } from "ai-journalist/ports";
const search: SearchClient = {
  async search(query, opts) {
    const hits = await myIndex.query(query, opts?.limit ?? 10);
    return hits.map((h) => ({ title: h.title, url: h.url, snippet: h.summary }));
  },
};
```

## WHAT the writing sounds like → `systemPrompt` + `BrandProfile`

`BrandProfile` threads the brand into every prompt (`name`, `publication`,
`beat`, `bylines`; optional `bannedWords`, `ctaBuilder`). Omit `systemPrompt` and
the preset builds a generic staff-journalist prompt from the brand; pass one to
own the voice entirely:

```ts
import { createDefaultInternals } from "ai-journalist/presets";

const brand = {
  name: "My Outlet",
  publication: "My Outlet (myoutlet.com)",
  beat: "climate tech",
  bylines: ["A. Writer"],
  bannedWords: ["synergy", "leverage"],
};

const internals = createDefaultInternals({
  llm, search, source, brand,
  systemPrompt: () =>
    `You are a skeptical climate-tech desk editor for ${brand.publication}. ` +
    `Ground every claim in the provided research; never invent figures.`,
});
```

## HOW MUCH it writes → `knobs`

`DefaultKnobs` are numeric tuning values with documented defaults; override any
subset via `knobs`. A few load-bearing ones:

- `maxSections` (7) — sections in the article.
- `sectionQueries` (3) / `snippetsPerQuery` (5) — research breadth/depth per section.
- `researchConcurrency` (4) — parallel research fan-out.
- `draftWordWarnFloor` (1500) — warn below this word count.
- `discoveryQueries` (15) / `newsCompanies` (12) — discovery-pass breadth.

```ts
const internals = createDefaultInternals({
  llm, search, source, brand,
  knobs: { maxSections: 5, snippetsPerQuery: 8, draftWordWarnFloor: 1200 },
});
```

## PARAPHRASE-grade dedup → `embedder`

Omit `embedder` and dedup is trigram-only (the documented degradation:
`embedDedupSurvivors` returns `null`). Pass any `Embedder` — one method,
`embed(texts) => Promise<number[][]>` — and the preset upgrades to embedding-grade
near-paraphrase dedup (cosine over a per-factory cache) for both discovery topics
and title candidates. An HTTP wrapper over your embedding service is the typical
production shape:

```ts
import type { Embedder } from "ai-journalist/ports";

const embedder: Embedder = {
  async embed(texts) {
    const res = await fetch(process.env.EMBED_URL!, {
      method: "POST",
      body: JSON.stringify({ texts }),
    });
    return (await res.json()).vectors as number[][];
  },
};

const internals = createDefaultInternals({ llm, search, source, brand, embedder });
```

## DOMAIN data woven in → `PipelineEnrichment`

`PipelineEnrichment<TBoard>` ([`pipeline.ts`](./pipeline.ts)) is the OPTIONAL
first-party layer — your site inventory, on-site entity links, and jobs-flavored
formatting. Omit it and the preset binds `neutralEnrichment()`: the core writes a
clean article with **no** first-party data or internal links. Supply it and the
pipeline weaves your data in and links out to your own pages. `TBoard` is your
concrete "one company's live board" type (it structurally satisfies
`PipelineBoardCompany`); implement only what you need — the rest can stay as the
neutral no-ops.

Field by field, and when you'd implement each:

**First-party DATA gathers** — implement when the engine should cite your own inventory:

- `gatherSiteData(category, limit)` → `PipelineSiteData` — totals + linkable
  companies/people for the site-inventory block. When: you want "N companies /
  M jobs on-site" grounding.
- `gatherLinkableEntities(category, companyLimit, peopleLimit)` → `PipelineLinkable`
  — the candidate pool the deterministic linker draws anchors from. When: you
  want on-site entity links.
- `gatherIndustryFreshHirers(category, limit, windowHours)` → `PipelineLinkEntity[]`
  — companies active in the window. When: you have a fresh-activity feed to feature.
- `gatherCompanyFreshJobs(companies, perCompany, windowHours)` → `TBoard[]` — the
  live board rows per company. When: you feature specific open roles.
- `gatherDatagodFacts(category, companies)` → `string` — a free-text first-party
  facts block. When: you have a stats desk to quote.

**Entity-linking + integrity tail** — implement when you want on-site links:

- `resolveArticleEntities(article, boardData, withRetry)` → `PipelineLinkEntity[]`
  — extract the entities the finished article actually mentions and resolve them
  to on-site URLs.
- `linkEntities(content, entities)` → `string` — rewrite the content to link
  those anchors.
- `withInternalLinks(article, boardCompanies)` → `GeneratedArticle` — the
  article-level link pass (e.g. a related-companies tail).
- `enforceLinkIntegrity(content)` → `{ content, stats }` — the final relative-link
  gate; `stats` is opaque (stuffed into telemetry).

**Jobs-flavored format helpers** (pure):

- `boardJobsLine(b)` → `string` — format one company's board line.
- `usLeanLocations(locations)` → `boolean` — a location filter.
- `shortForm(name)` → `string | null` — short corporate-suffix form of a name.

**Name stoplist + env knobs:**

- `linkNameStoplist: ReadonlySet<string>` — short ambiguous names never
  linked/matched.
- `enrichLimit`, `linkCompanyLimit`, `linkPeopleLimit`, `topicCompanies`,
  `topicCompanyJobs`, `topicJobsWindowHours` — the enrichment/linking tuning
  values.

The interface is `PipelineEnrichment<TBoard>`, declared in
[`pipeline.ts`](./pipeline.ts). Type your object against the preset's `enrichment`
option (resolvable via the `ai-journalist/presets` export):

```ts
import { createDefaultInternals } from "ai-journalist/presets";
import type { DefaultInternalsOptions } from "ai-journalist/presets";

// PipelineEnrichment<PipelineBoardCompany>, via the preset's option type.
type Enrichment = NonNullable<DefaultInternalsOptions["enrichment"]>;

const enrichment: Enrichment = {
  gatherSiteData: async (category, limit) => ({
    companies: await db.topCompanies(category, limit),
    people: [],
    jobCount: await db.jobCount(category),
    companyCount: await db.companyCount(category),
    domain: { label: category },
  }),
  gatherLinkableEntities: async (category, cl, pl) => ({
    companies: await db.linkableCompanies(category, cl),
    people: await db.linkablePeople(category, pl),
  }),
  // …implement the rest, or copy neutralEnrichment()'s no-ops for the parts you skip.
  gatherIndustryFreshHirers: async () => [],
  gatherCompanyFreshJobs: async () => [],
  gatherDatagodFacts: async () => "",
  resolveArticleEntities: async () => [],
  linkEntities: (content) => content,
  withInternalLinks: (article) => article,
  enforceLinkIntegrity: async (content) => ({ content, stats: null }),
  boardJobsLine: () => "",
  usLeanLocations: () => true,
  shortForm: () => null,
  linkNameStoplist: new Set<string>(),
  enrichLimit: 12,
  linkCompanyLimit: 8,
  linkPeopleLimit: 8,
  topicCompanies: 6,
  topicCompanyJobs: 3,
  topicJobsWindowHours: 72,
};

const internals = createDefaultInternals({ llm, search, source, brand, enrichment });
```

## OBSERVABILITY → `onEvent` / `onError` / `RunContext`

Pass `onEvent` and `onError` to the preset for streaming visibility; both default
to silent no-ops:

```ts
const internals = createDefaultInternals({
  llm, search, source, brand,
  onEvent: async (event) => logger.info({ event }, "pipeline event"),
  onError: (phase, error, context) => logger.error({ phase, error, context }, "pipeline error"),
});
```

Per-run telemetry (LLM usage, retries, artifacts, final article metrics)
accumulates in a `RunContext` ([`run-context.ts`](./run-context.ts)) and rides
out on the finished post's `telemetry`. Read `post.telemetry` after a run for the
gate results and per-run metrics.

## DEEP research → `createResearchStack` / `createExtractiveResearch`

The preset's default `gatherResearch` is a cheap snippet block from `search()`.
[`research.ts`](./research.ts) is an opt-in upgrade through the SAME seam —
`search` and `research`/`gatherResearch` on `createDefaultInternals` — no new
port to implement:

```ts
import { createResearchStack, createExtractiveResearch } from "ai-journalist/research";

// Production-grade grounding in three lines.
// IMPORTANT: construct the client with searchDefaults — the port's
// search(query, {limit}) cannot pass scrape/sources per call; without them
// results carry no content and every body silently degrades to its snippet.
const raw = createFirecrawlSearch({
  searchDefaults: { scrape: true, sources: ["news"] },
});
const stack = createResearchStack({ search: raw });
const internals = createDefaultInternals({
  llm, brand, source,
  search: stack.asSearchClient(), // sanitize+throttle+breaker on EVERY engine search (discovery snippets included)
  research: stack,                // binds gatherResearch + retryThin + run-telemetry hooks in one shot
});

// Or: full-page scrape + chunked LLM extraction (small-model friendly):
const internals2 = createDefaultInternals({ llm, brand, source,
  search: stack.asSearchClient(),
  gatherResearch: createExtractiveResearch({ llm, search: raw, pagesPerTopic: 3,
    chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400 }) });
```

`createResearchStack` adds query hygiene, source tiering, a throttled
gap-gated search with a dead-upstream breaker, primary-source chase, and a
dropped-URL thin-section backfill pool; `asSearchClient()` hands that SAME
hardening to every engine-side search call, not just `gatherResearch`.
`createExtractiveResearch` instead scrapes full pages and has the LLM extract
dense evidence bullets chunk by chunk — more LLM calls, but grounding that
holds up on small/local models. Both are opt-in; the preset's snippet default
is unchanged either way.

**"Local stack (Ollama on a small box)"**: set `sectionConcurrency: 1–2` and
`researchConcurrency: 1–2` (the preset's 3/4 defaults were tuned for cloud
APIs — one Ollama server queues parallel requests, and `OLLAMA_NUM_PARALLEL`
*divides* the loaded context between slots), keep search `limit ≤ 3` against a
memory-bound self-hosted Firecrawl (its own `MAX_CONCURRENCY` 2–3), and
construct the LLM with `options: { numCtx: 32768, keepAlive: "30m" }` (or set
`OLLAMA_CONTEXT_LENGTH` server-side) — silent server-side prompt truncation is
the failure mode.

---

## Escalation path

Reach for the least invasive seam that does the job, in this order:

1. **Preset defaults** — `createDefaultInternals({ llm, search, brand, source })`
   and nothing else.
2. **Override an option** — add `knobs` / `systemPrompt` / `model` / `onEvent` /
   `onError` / `enrichment` to the same call.
3. **Replace a port** — swap in your own `Source` / `Sink` / `SearchClient` /
   `LlmClient`.
4. **Fork a gate** — only when a gate's behavior itself must change: edit
   `gates.ts` and update its byte-lock in `gates.checks.ts` deliberately.
