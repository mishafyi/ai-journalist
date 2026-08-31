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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Firecrawl } from "firecrawl";
import type { SearchClient, SearchResult } from "../ports";

/** A union-shaped Firecrawl web hit — `SearchResultWeb` fields plus the
 *  `markdown` a scraped `Document` carries. Both are optional on the union. */
interface FirecrawlWebHit {
  url: string;
  title?: string;
  description?: string;
  markdown?: string;
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
  /** When set, every search writes one JSON file into `dir` — the query, the
   *  merged options, and the COMPLETE mapped results (scraped `content`
   *  elided to its length; titles/urls/snippets in full). Errors recorded
   *  too. Best-effort: tracing observes, it never fails a search. */
  trace?: { dir: string };
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
  let traceSeq = 0;
  function trace(
    query: string,
    merged: Record<string, unknown>,
    results: SearchResult[] | undefined,
    error?: unknown,
  ): void {
    if (opts.trace === undefined) return;
    try {
      mkdirSync(opts.trace.dir, { recursive: true });
      traceSeq += 1;
      writeFileSync(
        join(opts.trace.dir, `${String(traceSeq).padStart(3, "0")}-search.json`),
        JSON.stringify(
          {
            seq: traceSeq,
            ts: new Date().toISOString(),
            query,
            options: merged,
            ...(results === undefined
              ? {}
              : {
                  results: results.map((r) => ({
                    title: r.title,
                    url: r.url,
                    snippet: r.snippet,
                    ...(r.content === undefined ? {} : { contentChars: r.content.length }),
                  })),
                }),
            ...(error === undefined ? {} : { error: String(error) }),
          },
          null,
          1,
        ),
      );
    } catch {
      // tracing observes; it never fails a search
    }
  }

  return {
    async search(
      query,
      searchOpts?: { limit?: number; scrape?: boolean },
    ): Promise<SearchResult[]> {
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
        trace(query, merged, undefined, err);
        throw err;
      }
      const web = (data.web ?? []) as FirecrawlWebHit[];
      const results = web.map((r) => ({
        title: r.title ?? "",
        url: r.url,
        snippet: r.description ?? "",
        content: r.markdown,
      }));
      trace(query, merged, results);
      return results;
    },
    async scrape(url): Promise<string> {
      const doc = await fc.scrape(url, { formats: ["markdown"] });
      return doc.markdown ?? "";
    },
  };
}
