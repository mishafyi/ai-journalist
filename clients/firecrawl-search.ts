/**
 * Default `SearchClient` — Firecrawl via the official `firecrawl` SDK.
 *
 * Constructs Firecrawl as `new Firecrawl({ apiKey, apiUrl })`. The `apiUrl` is
 * REQUIRED — pass it explicitly or set `FIRECRAWL_API_URL` (e.g. the public
 * Firecrawl cloud, or your self-hosted host / keyed proxy). There is no built-in
 * default host, so the engine ships brand-clean.
 * `clients/**` is the one area permitted to touch the SDK + `process.env`.
 *
 * Response mapping (the SDK's field names differ from the port's):
 *   SDK `SearchResultWeb.description` → port `SearchResult.snippet`
 *   SDK `Document.markdown`          → port `SearchResult.content`
 *   SDK `Document.markdown`          → `scrape()` return
 *
 * `SearchData.web` entries are `SearchResultWeb | Document`: a plain SERP hit
 * carries `description`; a scraped hit (when `scrapeOptions` is set) is a
 * `Document` carrying `markdown`. The mapping reads both off the union.
 *
 * Uses `.scrape` (NOT the deprecated `.scrapeUrl` V1 alias).
 *
 * `searchDefaults` set construction-wide options every `search()` call
 * merges under its own per-call opts (per-call wins). `sources` is typed OFF
 * THE SDK (`Parameters<Firecrawl["search"]>`) because a plain `string[]`
 * fails strict tsc against firecrawl's literal-union `Array<"web"|"news"|
 * "images"|…>`.
 */
import { Firecrawl } from "firecrawl";
import type { SearchClient, SearchResult } from "../ports";
import type { Tracer } from "./trace";

/** A union-shaped Firecrawl web hit — `SearchResultWeb` fields plus the
 *  `markdown` a scraped `Document` carries. Both are optional on the union. */
interface FirecrawlWebHit {
  url: string;
  title?: string;
  description?: string;
  markdown?: string;
}

/**
 * Serialise search calls so consecutive ones are at least `minIntervalMs`
 * apart. Slots are reserved SYNCHRONOUSLY, so callers that fire in parallel
 * are spaced rather than all waiting the same interval and then racing.
 *
 * This exists because Firecrawl's search chain ends at its own DuckDuckGo
 * client, and DDG answers a burst with an anti-bot page. Firecrawl retries
 * that up to four times ~1s apart, which is too fast to clear the block, so
 * the whole budget is spent and the query returns empty — indistinguishable
 * from "this outlet did not cover the story". Measured 2026-09-03: four
 * back-to-back `site:` queries all blocked; the same shape 8s apart answered
 * every time. Spacing is the only lever the caller has.
 */
export function createPacer(minIntervalMs: number): () => Promise<void> {
  let nextAt = 0;
  return async (): Promise<void> => {
    if (minIntervalMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + minIntervalMs;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
}

/**
 * Build the default Firecrawl-backed `SearchClient`. `apiKey` falls back to
 * `FIRECRAWL_API_KEY`; `apiUrl` falls back to `FIRECRAWL_API_URL` and is
 * REQUIRED — throws if neither is set (env access is permitted in
 * `clients/**`). No host is hardcoded, so the engine ships brand-clean.
 */
export function createFirecrawlSearch(opts: {
  apiKey?: string;
  apiUrl?: string;
  /** Construction-wide search defaults — every `search()` call merges these
   *  UNDER its own per-call opts (per-call wins). */
  searchDefaults?: {
    sources?: NonNullable<Parameters<Firecrawl["search"]>[1]>["sources"];
    tbs?: string;
    scrape?: boolean;
  };
  /** Minimum gap between consecutive `search()` calls, in milliseconds.
   *  Omit (or 0) for no pacing. Applies to `search()` only — `scrape()` goes
   *  to the publisher, not to the search backend, and is not rate-limited the
   *  same way. See `createPacer` for why this is needed at all. */
  minIntervalMs?: number;
  /** When set, every search and scrape is recorded into its pipeline STEP's
   *  file — query, merged options and the complete results (a scrape keeps
   *  its full page text). Share one tracer with the LLM client so a step's
   *  searches and its model calls land together (`clients/trace.ts`). */
  trace?: Tracer;
}): SearchClient {
  const apiUrl = opts.apiUrl ?? process.env.FIRECRAWL_API_URL;
  if (apiUrl === undefined || apiUrl === "") {
    throw new Error(
      "createFirecrawlSearch: apiUrl is required — pass { apiUrl } or set " +
        "FIRECRAWL_API_URL (the Firecrawl host, e.g. the public cloud or your " +
        "self-hosted host / keyed proxy).",
    );
  }
  const fc = new Firecrawl({
    apiKey: opts.apiKey ?? process.env.FIRECRAWL_API_KEY,
    apiUrl,
  });
  const searchDefaults = opts.searchDefaults;
  const pace = createPacer(opts.minIntervalMs ?? 0);

  return {
    async search(
      query,
      searchOpts?: { limit?: number; scrape?: boolean },
    ): Promise<SearchResult[]> {
      await pace();
      // Defaults spread first, per-call opts win.
      const merged = { ...searchDefaults, ...searchOpts };
      // Never add `excludeDomains` — documented regression: SearXNG-backed
      // `/v2/search` returns ZERO results for any query carrying it (verified
      // in production 2026-07-08); host filtering is app-side (`isSkipHost`).
      let data;
      try {
        data = await fc.search(query, {
          limit: merged.limit,
          sources: merged.sources ?? ["web"],
          tbs: merged.tbs,
          scrapeOptions: merged.scrape
            ? { formats: ["markdown"], onlyMainContent: true }
            : undefined,
        });
      } catch (err: unknown) {
        opts.trace?.search({ query, op: "search", options: merged, error: String(err) });
        throw err;
      }
      const web = (data.web ?? []) as FirecrawlWebHit[];
      const results = web.map((r) => ({
        title: r.title ?? "",
        url: r.url,
        snippet: r.description ?? "",
        content: r.markdown,
      }));
      opts.trace?.search({
        query,
        op: "search",
        options: merged,
        results: results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          ...(r.content === undefined ? {} : { contentChars: r.content.length }),
        })),
      });
      return results;
    },
    async scrape(url): Promise<string> {
      try {
        const doc = await fc.scrape(url, { formats: ["markdown"] });
        const markdown = doc.markdown ?? "";
        opts.trace?.search({ query: url, op: "scrape", content: markdown });
        return markdown;
      } catch (err: unknown) {
        opts.trace?.search({ query: url, op: "scrape", error: String(err) });
        throw err;
      }
    },
  };
}
