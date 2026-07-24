/**
 * sources/lead-image.ts — one lead photo per story. Preference order:
 *   1. the outlet's own og:image from a source page we already cited
 *      (the actual news photo — legally the outlet's promo image),
 *   2. an Openverse Creative-Commons web-image search on the topic
 *      (keyless, licensed for reuse, always returns something).
 * Pure + injected `fetch` — no process.env (purity guard), never throws:
 * every path is best-effort and resolves to null on any failure.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** Reject URLs that are clearly not a story photo (logos, icons, sprites,
 *  generic social-card defaults). */
const JUNK_IMAGE_RE = /logo|\/default|placeholder|sprite|\/icon|social-|-social|\/favicon|\/apple-touch/i;

/** Pull og:image (twitter:image as fallback) out of a page's HTML. Returns a
 *  usable photo URL or null when absent/junk. Order-independent attribute
 *  matching — real pages put content= before or after property=. */
export function extractOgImage(html: string): string | null {
  const metas = html.match(/<meta[^>]+>/gi) ?? [];
  const byProp = (prop: string): string | null => {
    for (const tag of metas) {
      if (!new RegExp(`(property|name)\\s*=\\s*["']${prop}["']`, "i").test(tag)) continue;
      const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
      if (content !== undefined && content.startsWith("http") && !JUNK_IMAGE_RE.test(content)) return content;
    }
    return null;
  };
  return byProp("og:image") ?? byProp("og:image:url") ?? byProp("twitter:image") ?? byProp("twitter:image:src");
}

export interface LeadImage {
  url: string;
  credit: string;
  source: "source" | "openverse";
}

/** GET a page and read its og:image. Best-effort → null on any failure. */
export async function fetchOgImage(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": BROWSER_UA } });
    if (!res.ok) return null;
    return extractOgImage(await res.text());
  } catch {
    return null;
  }
}

interface OpenverseResult {
  url?: string;
  title?: string;
  creator?: string;
  license?: string;
}

/** Openverse CC web-image search — keyless, licensed. Best-effort → null. */
export async function searchOpenverse(query: string, fetchImpl: typeof fetch): Promise<LeadImage | null> {
  try {
    // extension filter → raster photos only (no SVG diagrams/symbol maps as leads).
    const api = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=3&mature=false&extension=jpg,jpeg,png,webp`;
    const res = await fetchImpl(api, { headers: { "User-Agent": BROWSER_UA } });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: OpenverseResult[] };
    const hit = body.results?.find((r) => typeof r.url === "string" && r.url.startsWith("http"));
    if (hit === undefined || hit.url === undefined) return null;
    const who = hit.creator !== undefined && hit.creator !== "" ? ` — ${hit.creator}` : "";
    return {
      url: hit.url,
      credit: `${hit.title ?? "image"}${who} (${hit.license ?? "CC"}) via Openverse`,
      source: "openverse",
    };
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The story's lead image: first good source og:image, else Openverse. */
export async function pickLeadImage(args: {
  sourceUrls: readonly string[];
  query: string;
  fetchImpl?: typeof fetch;
}): Promise<LeadImage | null> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  for (const url of args.sourceUrls.slice(0, 4)) {
    const og = await fetchOgImage(url, fetchImpl);
    if (og !== null) return { url: og, credit: hostOf(url), source: "source" };
  }
  return searchOpenverse(args.query, fetchImpl);
}
