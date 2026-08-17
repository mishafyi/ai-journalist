/**
 * sources/gallery.ts — every usable photo on the pages a story cites.
 *
 * The engine already picks ONE lead image (`lead-image.ts`). Two papers built
 * on it independently needed the same next thing — a set of photos, so an
 * article can run a slideshow instead of a single hero, and so a video pipeline
 * has more than one still to cut between. Both wrote it; both drifted.
 *
 * THE IDEA WORTH KEEPING is the meta/body trust split. A source page's
 * `og:image` is the outlet's own chosen photo OF THIS STORY, so it is reliably
 * on-topic. Its `<img>` tags are real photos too, but they include the
 * related-rail and trending thumbnails — clean, and about something else
 * entirely. Harvest therefore returns the two separately and prefers meta, so a
 * crime story never illustrates itself with a source page's politics-rail
 * thumbnails.
 *
 * Purity: injected `fetch`, no `process.env`, no brand literals (a paper's own
 * domains arrive as `ownHosts`). Nothing here throws — a dead source page must
 * never be able to fail a run.
 */

import { keepImage, normalizeImageUrl } from "./image";
import { provenanceOf } from "./provenance";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const PAGE_TIMEOUT_MS = 15_000;

/** Hosts that never yield a clean article photo whatever their provenance
 *  tier: chart/embed services that answer with a generated graphic. */
const NON_PHOTO_HOSTS = new Set(["quickchart.io", "chart.googleapis.com", "gist.github.com"]);

/**
 * Dedup signature for a photo URL.
 *
 * The same photograph is routinely served at several sizes, crops, or through a
 * resizer that carries the original as a `?url=` parameter. Keying on the
 * URL itself keeps all of them and the reader sees one picture four times.
 * This reduces to the inner original's FILENAME where there is one, and the
 * URL's own basename otherwise — so `…/w:1280/photo.jpg` and `…/w:388/photo.jpg`
 * collapse to a single entry.
 */
export function dedupeKey(url: string): string {
  try {
    const u = new URL(url);
    const inner = u.searchParams.get("url");
    const target = inner === null ? `${u.origin}${u.pathname}` : inner;
    const seg = target.replace(/\/+$/, "").split("/").pop();
    return decodeURIComponent(seg === undefined || seg === "" ? target : seg).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export interface PageImages {
  /** og:image / twitter:image — the outlet's chosen photo for THIS story. */
  meta: string[];
  /** `<img>` tags — real photos, but also off-topic recirculation rails. */
  body: string[];
}

/**
 * Split a page's images by trust. Every src is resolved to an absolute URL
 * against the page it came from, and unescaped in the same step: these come
 * straight off an HTML attribute, so a resizer URL arrives as
 * `…&amp;width=1200` (which answers 400 to everyone) and a body `<img>` src is
 * frequently relative.
 */
export function extractImages(html: string, pageUrl: string): PageImages {
  const meta: string[] = [];
  const body: string[] = [];
  const push = (arr: string[], raw: string | undefined): void => {
    if (raw === undefined || raw === "") return;
    const abs = normalizeImageUrl(raw.trim(), pageUrl);
    if (abs !== "") arr.push(abs);
  };
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (/(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/i.test(tag)) {
      push(meta, tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1]);
    }
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    push(body, tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]);
    // Lazy-loaded images keep the real photo in data-src and a placeholder in src.
    push(body, tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i)?.[1]);
    // First srcset candidate — the widths are appended after a space.
    const srcset = tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/i)?.[1];
    if (srcset !== undefined) push(body, srcset.split(",")[0].trim().split(/\s+/)[0]);
  }
  return { meta, body };
}

export interface CollectPagesArgs {
  /** URLs from the article's structured sources. */
  sourceUrls: readonly string[];
  /** Article body — inline links count as cited sources too. */
  markdown: string;
  /** The paper's OWN domains, so a story never harvests itself. */
  ownHosts: readonly string[];
  /** Cap on pages fetched per article. */
  limit: number;
}

/**
 * Candidate source pages: structured sources UNION the external links in the
 * body, deduped to ONE PAGE PER HOST (fetch an outlet once, not five times).
 *
 * The union matters: in a real archive the `sources` field is often thinner
 * than the body, and the outlets a piece actually leans on appear as inline
 * links. Deny-tier hosts are dropped here as well as at citation time — an
 * aggregator's page photo belongs to whoever it aggregated.
 */
export function collectSourcePages(args: CollectPagesArgs): string[] {
  const own = new Set(args.ownHosts.map((h) => h.replace(/^www\./, "").toLowerCase()));
  const urls: string[] = [...args.sourceUrls];
  for (const u of args.markdown.match(/https?:\/\/[^\s)"'\]]+/g) ?? []) urls.push(u);

  const byHost = new Map<string, string>();
  for (const u of urls) {
    const host = hostOf(u);
    if (host === "") continue;
    if (own.has(host) || [...own].some((o) => host.endsWith(`.${o}`))) continue;
    if (NON_PHOTO_HOSTS.has(host)) continue;
    if (provenanceOf(host) === "deny") continue;
    if (!byHost.has(host)) byHost.set(host, u);
  }
  return [...byHost.values()].slice(0, args.limit);
}

export interface GalleryPhoto {
  url: string;
  /** The host the photo ran on — what a credit line should name. */
  credit: string;
}

export interface HarvestResult {
  /** Every image seen before filtering — the ratio to kept is the useful signal. */
  found: number;
  meta: GalleryPhoto[];
  body: GalleryPhoto[];
}

export interface HarvestArgs {
  fetchImpl: typeof fetch;
  /** A photo already in hand (normally the lead), so it is not re-offered. */
  exclude?: string;
  log?: (line: string) => void;
}

/** Best-effort page fetch. A dead source returns "" rather than throwing. */
async function fetchPage(url: string, args: HarvestArgs): Promise<string> {
  try {
    const res = await args.fetchImpl(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return "";
    // A JSON or PDF answer to an article URL is not a page to scrape.
    if (!(res.headers.get("content-type") ?? "").includes("html")) return "";
    return await res.text();
  } catch (err: unknown) {
    args.log?.(`gallery: fetch failed ${url}: ${String(err).slice(0, 120)}`);
    return "";
  }
}

/**
 * Photos from a list of pages, split by trust and deduped across all of them.
 *
 * Returns `meta` and `body` separately rather than one merged list: the caller
 * decides how much it trusts body images. The usual rule is "meta alone if it
 * can fill the slot, body only to top up".
 */
export async function harvestPages(
  pageUrls: readonly string[],
  args: HarvestArgs,
): Promise<HarvestResult> {
  const excludeKey = args.exclude === undefined ? "" : dedupeKey(args.exclude);
  const seen = new Set<string>();
  const meta: GalleryPhoto[] = [];
  const body: GalleryPhoto[] = [];
  let found = 0;

  const take = (bucket: GalleryPhoto[], url: string, credit: string): void => {
    found += 1;
    if (!keepImage(url)) return;
    const key = dedupeKey(url);
    if (key === excludeKey || seen.has(key)) return;
    seen.add(key);
    bucket.push({ url, credit });
  };

  for (const pageUrl of pageUrls) {
    const html = await fetchPage(pageUrl, args);
    if (html === "") continue;
    const credit = hostOf(pageUrl);
    const imgs = extractImages(html, pageUrl);
    for (const img of imgs.meta) take(meta, img, credit);
    for (const img of imgs.body) take(body, img, credit);
  }
  args.log?.(`gallery: ${pageUrls.length} page(s) → ${found} images, ${meta.length} meta + ${body.length} body kept`);
  return { found, meta, body };
}

/**
 * The common shape: at least `want` photos, on-topic first.
 *
 * Meta alone when it can carry the set, otherwise meta followed by body as a
 * top-up. Returns fewer than `want` (possibly none) rather than padding with
 * anything it does not trust.
 */
export function pickGallery(result: HarvestResult, want: number): GalleryPhoto[] {
  const chosen = result.meta.length >= want ? result.meta : [...result.meta, ...result.body];
  return chosen.slice(0, want);
}
