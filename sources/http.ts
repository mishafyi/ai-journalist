/**
 * HttpSource — the flagship built-in `Source`: "plug any data in" by CONFIG.
 *
 *   Layer 1 · Point it at a CONFORMING endpoint (returns `DiscoverySignal` /
 *             `GroundingFacts` / `CoveredTopic[]`). The response is Zod-validated
 *             via `parseSignal`/`parseFacts`/`parseCovered`, so a malformed
 *             payload fails LOUD at the seam — it never degrades to an empty
 *             signal. This is how a host feeds the engine from its own API.
 *
 *   Layer 2 · Point it at ANY endpoint + a tiny `map*` fn. When `mapSignal`/
 *             `mapFacts`/`mapCovered` is given, the engine trusts the adapter to
 *             produce the right shape and SKIPS the Zod gate (the adapter owns
 *             the contract). A few lines bridge any foreign response.
 *
 * `gatherFacts` is only exposed when `factsUrl` is set; `coveredTopics` only
 * when `coveredUrl` is set — so a signal-only endpoint yields a signal-only
 * Source (matches the optional `Source` methods).
 *
 * On a non-200 we THROW with the status + a best-effort body slice. The
 * `.catch(() => "")` on `res.text()` is a deliberate error-message read (so a
 * body that itself fails to read doesn't mask the real status), not a swallow.
 *
 * Imports only `./ports` + `./schemas` + Node built-ins (`fetch`,
 * `AbortSignal`) — nothing from a host app, no `process.env`, no SDKs.
 */
import type {
  CoveredTopic,
  DiscoverySignal,
  GroundingFacts,
  Source,
  TopicBrief,
} from "../ports";
import { parseCovered, parseFacts, parseSignal } from "../schemas";

/** How many chars of a failed response body to fold into the thrown message. */
const ERROR_BODY_SLICE = 500;
/** Default per-request fetch timeout (ms). */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpSourceConfig {
  /** Endpoint returning the discovery signal. Required. */
  signalUrl: string;
  /** Endpoint returning first-party grounding facts. Omit → no `gatherFacts`. */
  factsUrl?: string;
  /** Endpoint returning already-covered topics. Omit → no `coveredTopics`. */
  coveredUrl?: string;
  /** Headers sent on every request (e.g. `{ authorization: "Bearer …" }`). */
  headers?: Record<string, string>;
  /** Per-request timeout in ms (default 15s). */
  timeoutMs?: number;
  /** Layer 2 — bridge a foreign signal shape; bypasses Zod validation. */
  mapSignal?: (raw: unknown) => DiscoverySignal;
  /** Layer 2 — bridge a foreign facts shape; bypasses Zod validation. */
  mapFacts?: (raw: unknown, topic: TopicBrief) => GroundingFacts;
  /** Layer 2 — bridge a foreign covered-topics shape; bypasses Zod validation. */
  mapCovered?: (raw: unknown) => CoveredTopic[];
}

/** GET `url` as JSON, timing out via `AbortSignal.timeout`; throw on non-200. */
async function fetchJson(
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `HttpSource: GET ${url} → ${res.status} ${res.statusText}` +
        (body ? ` — ${body.slice(0, ERROR_BODY_SLICE)}` : ""),
    );
  }
  return res.json();
}

export function createHttpSource(cfg: HttpSourceConfig): Source {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const source: Source = {
    async gatherSignal(): Promise<DiscoverySignal> {
      const raw = await fetchJson(cfg.signalUrl, cfg.headers, timeoutMs);
      return cfg.mapSignal ? cfg.mapSignal(raw) : parseSignal(raw);
    },
  };

  if (cfg.factsUrl) {
    const factsUrl = cfg.factsUrl;
    source.gatherFacts = async (topic: TopicBrief): Promise<GroundingFacts> => {
      const raw = await fetchJson(factsUrl, cfg.headers, timeoutMs);
      return cfg.mapFacts ? cfg.mapFacts(raw, topic) : parseFacts(raw);
    };
  }

  if (cfg.coveredUrl) {
    const coveredUrl = cfg.coveredUrl;
    source.coveredTopics = async (): Promise<CoveredTopic[]> => {
      const raw = await fetchJson(coveredUrl, cfg.headers, timeoutMs);
      return cfg.mapCovered ? cfg.mapCovered(raw) : parseCovered(raw);
    };
  }

  return source;
}
