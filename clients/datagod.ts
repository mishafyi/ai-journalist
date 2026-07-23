/**
 * DataGod client — a GENERIC envelope client for a self-hosted DataGod
 * instance (https://github.com/mishafyi/datagod): one keyed FastAPI gateway
 * over 22 primary data sources (FRED, SEC EDGAR, USAspending, Treasury,
 * Nasdaq, …) behind a single response envelope.
 *
 * Deliberately NOT per-source: `get(path, params)` speaks the envelope and
 * nothing else, so sources added upstream are usable immediately as new path
 * strings — the adapter never changes for additions. Which endpoint serves
 * which story is the CALLER's config (see presets/news-desk.ts DATA_PLAYS).
 *
 * Reference-client conventions (same as firecrawl/searxng/ollama): this file
 * may read nothing from env itself — config arrives as arguments; checks are
 * offline-mocked plus a live-skip parity check.
 */

export interface DatagodEnvelope {
  meta: { source: string; endpoint: string; timestamp: string; status: string };
  data: unknown;
  error: string | null;
}

export interface DatagodClient {
  /** Fetch one endpoint; returns the envelope's `data` payload. Throws with
   *  full context on HTTP or envelope errors — callers treat plays as
   *  best-effort and catch. */
  get(path: string, params?: Record<string, string | number>): Promise<unknown>;
}

export function createDatagod(cfg: {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): DatagodClient {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.apiUrl.replace(/\/$/, "");
  return {
    async get(path, params) {
      const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
      for (const [k, v] of Object.entries(params ?? {})) {
        url.searchParams.set(k, String(v));
      }
      const res = await doFetch(url.toString(), {
        headers: { "X-API-Key": cfg.apiKey },
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
      });
      const body = await res.text();
      if (!res.ok) {
        throw new Error(
          `datagod GET ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`,
        );
      }
      const envelope = JSON.parse(body) as DatagodEnvelope;
      if (envelope.meta?.status !== "success" || envelope.error !== null) {
        throw new Error(
          `datagod GET ${path} → envelope error: ${envelope.error ?? envelope.meta?.status}`,
        );
      }
      return envelope.data;
    },
  };
}
