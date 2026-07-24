/**
 * sources/lead-image.ts — one lead photo per story. Preference order:
 *   1. the outlet's own og:image from a source page we already cited
 *      (the actual news photo — legally the outlet's promo image),
 *   2. a Google Images search through a keyed SearXNG proxy (operator,
 *      2026-07-24: "just use searxng google images - not Openverse").
 * Pure + injected `fetch` — no process.env (purity guard), never throws:
 * every path is best-effort and resolves to null on any failure. The proxy
 * URL/key are deployment secrets, so they arrive as an injected config.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** Reject URLs that are clearly not a story photo (logos, icons, sprites,
 *  generic social-card defaults). */
const JUNK_IMAGE_RE = /logo|\/default|placeholder|sprite|\/icon|social-|-social|\/favicon|\/apple-touch/i;

/** Image hosts whose promo images carry the outlet's own branding baked into
 *  the pixels — a Guardian og:image ships with the Guardian live-blog overlay
 *  (operator rule 2026-07-24: "don't take guardian images"). Skipping the
 *  host falls through to the next outlet's photo or the image search. */
const BRANDED_IMAGE_HOSTS = ["guim.co.uk", "guardianapis.com"];

export function isBrandedImageHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return BRANDED_IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Pull og:image (twitter:image as fallback) out of a page's HTML. Returns a
 *  usable photo URL or null when absent/junk. Order-independent attribute
 *  matching — real pages put content= before or after property=. */
export function extractOgImage(html: string): string | null {
  const metas = html.match(/<meta[^>]+>/gi) ?? [];
  const byProp = (prop: string): string | null => {
    for (const tag of metas) {
      if (!new RegExp(`(property|name)\\s*=\\s*["']${prop}["']`, "i").test(tag)) continue;
      const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
      if (
        content !== undefined &&
        content.startsWith("http") &&
        !JUNK_IMAGE_RE.test(content) &&
        !isBrandedImageHost(content)
      )
        return content;
    }
    return null;
  };
  return byProp("og:image") ?? byProp("og:image:url") ?? byProp("twitter:image") ?? byProp("twitter:image:src");
}

export interface LeadImage {
  url: string;
  credit: string;
  source: "source" | "search";
}

/** The keyed SearXNG proxy that fronts the google-images engine. */
export interface ImageSearchConfig {
  url: string;
  apiKey: string;
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

interface ProxyImageResult {
  url?: string;
  title?: string;
  imgSrc?: string;
}

/** Google Images via the keyed SearXNG proxy. Returns the first hit whose
 *  image URL is a real photo on an unbranded host; credit is the page's host
 *  (where the photo ran). Best-effort → null. */
export async function searchGoogleImages(
  query: string,
  cfg: ImageSearchConfig,
  fetchImpl: typeof fetch,
): Promise<LeadImage | null> {
  try {
    const api = `${cfg.url.replace(/\/+$/, "")}?q=${encodeURIComponent(query)}&type=images&engines=${encodeURIComponent("google images")}&num=10`;
    const res = await fetchImpl(api, {
      headers: { "User-Agent": BROWSER_UA, "x-api-key": cfg.apiKey },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: ProxyImageResult[] };
    const hit = body.results?.find(
      (r) =>
        typeof r.imgSrc === "string" &&
        r.imgSrc.startsWith("http") &&
        !JUNK_IMAGE_RE.test(r.imgSrc) &&
        !isBrandedImageHost(r.imgSrc),
    );
    if (hit === undefined || hit.imgSrc === undefined) return null;
    return { url: hit.imgSrc, credit: hostOf(hit.url ?? hit.imgSrc), source: "search" };
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

/** The story's lead image: first good source og:image, else Google Images
 *  through the proxy (when configured). */
export async function pickLeadImage(args: {
  sourceUrls: readonly string[];
  query: string;
  imageSearch?: ImageSearchConfig;
  fetchImpl?: typeof fetch;
}): Promise<LeadImage | null> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  for (const url of args.sourceUrls.slice(0, 4)) {
    const og = await fetchOgImage(url, fetchImpl);
    if (og !== null) return { url: og, credit: hostOf(url), source: "source" };
  }
  if (args.imageSearch === undefined) return null;
  return searchGoogleImages(args.query, args.imageSearch, fetchImpl);
}
