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

import { provenanceOf } from "./provenance";
import { isBrandedImageHost, keepImage } from "./image";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/**
 * One verdict for "is this a usable story photo", shared with every other
 * caller in the engine.
 *
 * This module used to carry its own JUNK_IMAGE_RE and BRANDED_CARD_RE, a
 * weaker filter than the papers downstream had independently grown: no stock
 * agencies, no URL-encoded size check, no vector/animated extension test. Both
 * are now `keepImage` in ./image, and the four tokens this module had that the
 * other did not (social-, -social, /brand, .image.png) were carried across.
 */
function usablePhoto(url: string): boolean {
  return keepImage(url) && !isBrandedImageHost(url);
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
        usablePhoto(content)
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
  usedImages?: ReadonlySet<string>,
): Promise<LeadImage | null> {
  try {
    const api = `${cfg.url.replace(/\/+$/, "")}?q=${encodeURIComponent(query)}&type=images&engines=${encodeURIComponent("google images")}&num=10`;
    const res = await fetchImpl(api, {
      headers: { "User-Agent": BROWSER_UA, "x-api-key": cfg.apiKey },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: ProxyImageResult[] };
    const used = usedImages ?? new Set<string>();
    const hit = body.results?.find(
      (r) =>
        typeof r.imgSrc === "string" &&
        r.imgSrc.startsWith("http") &&
        usablePhoto(r.imgSrc) &&
        !used.has(r.imgSrc.split("?")[0]),
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
  /** Source-image URLs already used by other articles — a source og:image
   *  that matches one is SKIPPED so two related stories from the same outlet
   *  don't share a photo (live 2026-07-27). Compared on the URL sans query. */
  usedImages?: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
}): Promise<LeadImage | null> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const used = args.usedImages ?? new Set<string>();
  const bare = (u: string): string => u.split("?")[0];
  for (const url of args.sourceUrls.slice(0, 4)) {
    // A deny-tier host's photo is a deny-tier host's brand on the front page:
    // telegraph.com's red WordPress card ran as a lead (2026-08-16).
    if (provenanceOf(hostOf(url)) === "deny") continue;
    const og = await fetchOgImage(url, fetchImpl);
    if (og !== null && !used.has(bare(og))) return { url: og, credit: hostOf(url), source: "source" };
  }
  if (args.imageSearch === undefined) return null;
  return searchGoogleImages(args.query, args.imageSearch, fetchImpl, used);
}
