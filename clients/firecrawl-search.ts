/**
 * Default `SearchClient` — Firecrawl via the official `firecrawl` SDK.
 *
 * Constructs Firecrawl as `new Firecrawl({ apiKey, apiUrl })`. The `apiUrl` is
 * REQUIRED — pass it explicitly or set `FIRECRAWL_API_URL` (e.g. the public
 * Firecrawl cloud, or your self-hosted host / keyed proxy). There is no built-in
 * default host, so the engine ships brand-clean.
 * `engine/clients/**` is the one area permitted to touch the SDK + `process.env`.
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
 */
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
 * `engine/clients/**`). No host is hardcoded, so the engine ships brand-clean.
 */
export function createFirecrawlSearch(opts: {
  apiKey?: string;
  apiUrl?: string;
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

  return {
    async search(
      query,
      searchOpts?: { limit?: number; scrape?: boolean },
    ): Promise<SearchResult[]> {
      const data = await fc.search(query, {
        limit: searchOpts?.limit,
        sources: ["web"],
        scrapeOptions: searchOpts?.scrape
          ? { formats: ["markdown"], onlyMainContent: true }
          : undefined,
      });
      const web = (data.web ?? []) as FirecrawlWebHit[];
      return web.map((r) => ({
        title: r.title ?? "",
        url: r.url,
        snippet: r.description ?? "",
        content: r.markdown,
      }));
    },
    async scrape(url): Promise<string> {
      const doc = await fc.scrape(url, { formats: ["markdown"] });
      return doc.markdown ?? "";
    },
  };
}
