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
  /** Fetch one endpoint's raw body (a filing's HTML, not an envelope). */
  getText(path: string, params?: Record<string, string | number>): Promise<string>;
}

/** Statuses that pass: a rate limit, a gateway error, a timeout. DataGod passes
 *  an upstream 4xx straight through and retries a 5xx only in some clients,
 *  never a 429 (2026-09-18). */
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const ATTEMPTS = 3;

export function createDatagod(cfg: {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Pause before retry n, in ms (n × this); the checks pass 0. */
  retryDelayMs?: number;
}): DatagodClient {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.apiUrl.replace(/\/$/, "");
  const retryDelay = cfg.retryDelayMs ?? 5_000;
  /** The body of a 2xx reply; a transient failure (status above, a dropped
   *  connection, our own timeout) is tried again, twice, then thrown. */
  const fetchBody = async (path: string, params?: Record<string, string | number>): Promise<string> => {
    const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      url.searchParams.set(k, String(v));
    }
    let lastError: unknown = new Error(`datagod GET ${path}: no attempt made`);
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let status = 0;
      try {
        const res = await doFetch(url.toString(), {
          headers: { "X-API-Key": cfg.apiKey },
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
        });
        const body = await res.text();
        if (res.ok) return body;
        status = res.status;
        lastError = new Error(`datagod GET ${path} ${JSON.stringify(params ?? {})} → HTTP ${res.status}: ${body.slice(0, 300)}`);
      } catch (err: unknown) {
        lastError = err;
      }
      if (status !== 0 && !TRANSIENT.has(status)) throw lastError;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * retryDelay));
    }
    throw lastError;
  };
  return {
    async get(path, params) {
      const body = await fetchBody(path, params);
      const envelope = JSON.parse(body) as DatagodEnvelope;
      if (envelope.meta?.status !== "success" || envelope.error !== null) {
        throw new Error(
          `datagod GET ${path} → envelope error: ${envelope.error ?? envelope.meta?.status}`,
        );
      }
      return envelope.data;
    },
    getText: fetchBody,
  };
}
