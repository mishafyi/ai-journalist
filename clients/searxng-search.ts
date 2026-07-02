/**
 * Reference `SearchClient` for a self-hosted SearXNG metasearch instance
 * (JSON API: GET {baseUrl}/search?q=…&format=json). `clients/**` may read env:
 * `baseUrl` falls back to SEARXNG_URL; there is no baked-in default host, so
 * the engine ships brand-clean. Requires the instance to allow `format=json`
 * (SearXNG `search.formats: [html, json]`).
 */
import type { SearchClient, SearchResult } from "../ports";

interface SearxngHit {
  title?: string;
  url?: string;
  content?: string;
}

export function createSearxngSearch(opts: {
  baseUrl?: string;
  /** Comma-separated engine list (SearXNG `engines=` param). */
  engines?: string;
  language?: string;
  timeoutMs?: number;
}): SearchClient {
  const baseUrl = (opts.baseUrl ?? process.env.SEARXNG_URL)?.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "createSearxngSearch: baseUrl (or SEARXNG_URL) is required",
    );
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    async search(query, searchOpts): Promise<SearchResult[]> {
      const params = new URLSearchParams({ q: query, format: "json" });
      if (opts.engines) params.set("engines", opts.engines);
      if (opts.language) params.set("language", opts.language);
      const res = await fetch(`${baseUrl}/search?${params}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(
          `searxng search failed: HTTP ${res.status} ${await res
            .text()
            .then((t) => t.slice(0, 200))
            .catch(() => "")}`,
        );
      }
      const body = (await res.json()) as { results?: SearxngHit[] };
      const limit = searchOpts?.limit ?? 10;
      return (body.results ?? [])
        .filter((r): r is Required<Pick<SearxngHit, "title" | "url">> & SearxngHit =>
          Boolean(r.title && r.url),
        )
        .slice(0, limit)
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content ?? "",
        }));
    },
  };
}
