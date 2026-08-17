/**
 * sources/image.ts — is this URL a real editorial photo, and is it big enough?
 *
 * Upstreamed from two papers that had each grown their own copy of this and
 * then DRIFTED: one had a pixel floor, a stock-host list and a URL junk filter
 * the other never received, so it published lead images with no quality gate
 * at all. Everything here is the union of both, plus what `lead-image.ts` was
 * doing with weaker regexes of its own.
 *
 * Three separable jobs, deliberately not merged:
 *
 *   1. `keepImage(url)`   — cheap URL verdict, no network. Junk tokens, stock
 *                           agencies, vector/animated extensions, and sizes
 *                           encoded in the URL.
 *   2. `downloadImage()`  — fetch it, enforce content-type and a byte cap.
 *   3. `imageDims()` +    — the ACTUAL pixels, read from the file header. URL
 *      `meetsLeadFloor()`   heuristics let a 200x200 graphic through; only the
 *                           bytes settle it.
 *
 * Purity: injected `fetch`, no `process.env`, no `Buffer` (DataView instead, so
 * this runs anywhere a Uint8Array does). Storage is NOT here — the engine
 * decides whether a photo is usable; a `Sink` decides where it lives.
 */

/**
 * The URL does not serve a usable image — a hot-link 403, a 404, a host
 * answering an image URL with HTML, or a file below the pixel floor.
 *
 * Distinct from a transient failure (timeout, size cap, upload hiccup) because
 * it is a verdict about the URL itself: a browser would get the same answer, so
 * keeping it as a "fallback" only buys a broken frame. Callers drop the URL.
 */
export class DeadImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadImageError";
  }
}

/** Wikimedia/Flickr/most CDNs 403 a default fetch UA. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** SVG is absent on purpose: a script vector, not a photo. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Undo the HTML escaping a scraped `<meta og:image content="…&amp;auth=…">`
 * carries, then serialize through the WHATWG parser.
 *
 * Both halves are scar tissue. A CDN resizer reads `&amp;width=1200` as one
 * giant parameter name and answers 400 — indistinguishable from hot-link
 * protection, and it cost three front-page photos. Separately, a raw space in a
 * scraped URL fails downstream URL validation; `new URL().toString()`
 * percent-encodes it without double-encoding existing `%XX`.
 *
 * `base` resolves relative srcs scraped off a page; pass `undefined` when the
 * input is expected to be absolute. Anything unparseable or non-http(s)
 * returns "" — no image beats a publish that can never succeed.
 */
export function normalizeImageUrl(url: string, base: string | undefined): string {
  const unescaped = url.replace(/&amp;/g, "&");
  try {
    const u = new URL(unescaped, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * Watermark/stock houses, branded station cards, and chrome/tracking/social
 * junk. Substring match on the lowercased URL.
 *
 * Every entry is a live escape, and the ABSENCES are load-bearing:
 *   • no "getty" — outlet CDNs name licensed files after the asset
 *     (`…/gettyimages-2100.jpg`) and it binned clean CBS photos. Watermarked
 *     previews are caught by STOCK_HOSTS on the HOST instead.
 *   • no "pixel" — "1x1" already catches tracking pixels, and it binned every
 *     Google Pixel photo.
 *   • no "1200x630" — that is the standard social crop, so outlets serve REAL
 *     photos at it (15 CBS leads lost). The og-card junk it was meant for is
 *     caught precisely by facebook-default / metatag / og_image.
 */
const REJECT = [
  "watermark",
  "dicebear", "overlay-toi_sw",
  "logo", "sprite", "favicon", "apple-touch", "placeholder",
  "spacer", "blank.", "1x1", "headshot",
  "%7b", "${",
  "bloximages", "townnews", "/tncms/", "guim.co.uk", "/plugins/", "/themes/",
  "-og.", "/og-", "og-image", "og_image", "promo", "metatag", "facebook-default",
  "-default-wide", "fallback", "/funders/", "/news-sites/",
  "app-store", "appstore", "google-play", "googleplay", "google-store", "play.google",
  "playstore", "badge", "_active", "gravatar", "/avatar", "avatar-",
  "scorecardresearch", "doubleclick", "crwdcntrl", "/ads/", "privacy-",
  "doc-conversion", "mde-images", "stansberryresearch",
  "nativead", "native-ad", "sponsor", "-button", "_button",
  // Carried over from lead-image.ts's own JUNK_IMAGE_RE when that module was
  // consolidated onto keepImage — without these four, folding the two filters
  // together would have QUIETLY WEAKENED the lead picker.
  "social-", "-social", "/brand", ".image.png",
];

/**
 * Stock agencies whose OWN site serves watermarked previews. Matched on the
 * HOST, never as a substring of the whole URL: an outlet licenses a frame and
 * re-serves it from its own CDN keeping the agency's asset id in the FILENAME,
 * and that copy carries no watermark. Substring-matching "gettyimages"
 * rejected 66 clean press photos across one archive.
 */
const STOCK_HOSTS = [
  "gettyimages.com", "gettyimages.co.uk", "shutterstock.com", "alamy.com",
  "istockphoto.com", "dreamstime.com", "123rf.com", "depositphotos.com",
  "apimages.com", "stock.adobe.com",
];

/** Image hosts whose promo images carry the outlet's branding baked into the
 *  pixels — a Guardian og:image ships with the live-blog overlay. */
const BRANDED_IMAGE_HOSTS = ["guim.co.uk", "guardianapis.com"];

/** Junk only when it is its OWN path/file token: "icon" as a bare substring
 *  rejected a real photo of SEMICON China (SEMI-CON-tains it). */
const ICON_RE = /(^|[/_.-])icons?([/_.-]|$)/i;

function hostMatches(url: string, hosts: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** True when the promo image carries the outlet's own branding in the pixels. */
export function isBrandedImageHost(url: string): boolean {
  return hostMatches(url, BRANDED_IMAGE_HOSTS);
}

/** Vector and animated files, tested on the PATH's extension rather than as a
 *  substring: Wikimedia renders an SVG to a raster at
 *  `…/Flag.svg/1280px-Flag.svg.png` — a real 1280px PNG whose URL merely
 *  mentions .svg. A genuinely SVG response is refused again by content-type. */
function badExtension(url: string): boolean {
  try {
    // `/svg` as the final segment catches extensionless generator endpoints.
    return /\.(svg|gif)$|\/svg$/.test(new URL(url).pathname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Reject small images by any dimension encoded in the URL — the largest found
 * under 400px is a thumbnail/avatar/icon. Big-photo safe: aspect ratios like
 * `c=16x9` lack the leading delimiter, and the MAX rule keeps a `w_1200,h_50`
 * crop on its 1200.
 */
function tooSmall(url: string): boolean {
  // An explicit resize/display OUTPUT size is authoritative — a big source crop
  // (`crop/2558x2558/resize/60x60`) must not mask a 60px avatar output.
  const out = url.match(/\/(?:resize|fit-in|display)\/(\d{2,4})x(\d{2,4})/i);
  if (out !== null) return Math.max(Number(out[1]), Number(out[2])) < 400;
  const dims: number[] = [];
  for (const m of url.matchAll(/[-_/](\d{2,4})x(\d{2,4})/gi)) dims.push(Number(m[1]), Number(m[2]));
  for (const m of url.matchAll(/[?&;](?:w|h|width|height|fit|resize)=(\d{2,4})/gi)) dims.push(Number(m[1]));
  for (const m of url.matchAll(/[/_:,;=](?:w|h)[_:]?(\d{2,4})/gi)) dims.push(Number(m[1]));
  // Wikimedia's scaled form: /thumb/a/ab/File.jpg/800px-File.jpg — judged on
  // its actual width instead of the word "thumb" in its path.
  for (const m of url.matchAll(/[/_-](\d{2,4})px[-_]/gi)) dims.push(Number(m[1]));
  return dims.length > 0 && Math.max(...dims) < 400;
}

/** Keep only clean, full-size, http(s) editorial photos. No network. */
export function keepImage(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (hostMatches(url, STOCK_HOSTS) || badExtension(url)) return false;
  const low = url.toLowerCase();
  if (REJECT.some((r) => low.includes(r)) || ICON_RE.test(low)) return false;
  return !tooSmall(low);
}

export interface ImageDims {
  width: number;
  height: number;
}

/**
 * Leads must be at least this on their longest side. A front-page splash
 * renders ~736px wide and cards are commonly served at 600x400, so anything
 * under 800 is already upscaling somewhere — a 306x172 thumbnail ran as a lead
 * and read as a blurry smear.
 *
 * Judged on the LONGEST side, matching how frames scale: a 490x665 portrait is
 * refused on its 665. A narrow-but-very-tall source (500x1200) still passes on
 * height while upscaling across a 600px card width; per-axis minimums if that
 * ever shows up.
 */
export const MIN_LEAD_PX = 800;

/** Whether `imageDims()` output clears the floor. `null` (format not
 *  recognized, e.g. AVIF) passes UN-JUDGED rather than rejecting blind. */
export function meetsLeadFloor(dims: ImageDims | null): boolean {
  return dims === null || Math.max(dims.width, dims.height) >= MIN_LEAD_PX;
}

/** Read `len` bytes as latin1 — the magic-number strings are all ASCII. */
function tag(b: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = start; i < start + len && i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return s;
}

/**
 * Pixel dimensions from the first bytes of a PNG/JPEG/WebP/GIF, or null when
 * the format isn't recognized.
 *
 * No AVIF: its box-walk isn't worth owning, and null passes the floor
 * un-judged rather than rejecting blind. DataView rather than Buffer so this
 * stays runtime-agnostic.
 */
export function imageDims(data: Uint8Array): ImageDims | null {
  if (data.length < 30) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // PNG: 8-byte signature, IHDR width/height at 16/20 (big-endian).
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
  }
  // GIF: "GIF8", logical screen size at 6/8 (little-endian).
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // WebP: RIFF….WEBP, then one of three chunk layouts.
  if (tag(data, 0, 4) === "RIFF" && tag(data, 8, 4) === "WEBP") {
    const kind = tag(data, 12, 4);
    if (kind === "VP8 ") {
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (kind === "VP8L") {
      const width = 1 + (((data[22] & 0x3f) << 8) | data[21]);
      const height = 1 + (((data[24] & 0x0f) << 10) | (data[23] << 2) | ((data[22] & 0xc0) >> 6));
      return { width, height };
    }
    if (kind === "VP8X") {
      // 24-bit little-endian, minus one.
      const le24 = (o: number): number => data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
      return { width: 1 + le24(24), height: 1 + le24(27) };
    }
    return null;
  }
  // JPEG: walk the markers to the first SOFn frame header.
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = data[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // SOF0-SOF15 carry the frame size; C4/C8/CC are DHT/JPG/DAC, not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: dv.getUint16(i + 5, false), width: dv.getUint16(i + 7, false) };
      }
      i += 2 + dv.getUint16(i + 2, false);
    }
    return null;
  }
  return null;
}

/** A filename a file-storage backend will accept: keep the source name when it
 *  looks sane, append the content-type's extension when it doesn't (plenty of
 *  image URLs end in `/original` or a bare id). */
export function imageFilename(url: string, contentType: string): string {
  let base = "lead";
  try {
    base = (new URL(url).pathname.split("/").pop() ?? "").replace(/[^A-Za-z0-9._-]/g, "-").slice(-80);
  } catch {
    // Unparseable URL — the caller already fetched it fine, just name it.
  }
  if (/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) return base;
  const ext = contentType.split("/")[1] ?? "jpg";
  return `${base === "" ? "lead" : base}.${ext}`;
}

export interface DownloadedImage {
  /** Upload-ready, typed with the served content-type. */
  blob: Blob;
  filename: string;
  bytes: number;
  /** Raw bytes, so the caller can run `imageDims` without re-reading the blob. */
  data: Uint8Array;
}

/**
 * GET an image URL as an upload-ready blob.
 *
 * Throws `DeadImageError` when the URL is not a usable photo (bad status, wrong
 * content-type, empty body) and a plain `Error` for transient/size failures —
 * the distinction is the point: callers DROP a dead URL and RETRY a transient
 * one. The pixel floor is NOT applied here; call `imageDims`/`meetsLeadFloor`
 * on `data`, so a caller who wants a non-lead image can skip it.
 */
export async function downloadImage(
  escapedUrl: string,
  fetchImpl: typeof fetch,
): Promise<DownloadedImage> {
  const url = normalizeImageUrl(escapedUrl, undefined);
  if (url === "") throw new DeadImageError(`unusable image URL: ${escapedUrl.slice(0, 120)}`);
  const res = await fetchImpl(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "image/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new DeadImageError(`GET ${url} → ${res.status} ${res.statusText}`);

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) {
    throw new DeadImageError(
      `GET ${url} → refusing content-type "${contentType === "" ? "(none)" : contentType}" ` +
        `(want one of ${[...IMAGE_TYPES].join(", ")})`,
    );
  }

  // Declared size first, so an oversized file is refused before it is pulled.
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) {
    throw new Error(`GET ${url} → content-length ${declared} over cap ${MAX_IMAGE_BYTES}`);
  }

  // Buffered, not streamed: the cap is re-checked after the read, so a lying
  // content-length costs one buffered body. Stream with a running byte count if
  // a hostile source ever matters here.
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`GET ${url} → ${bytes.byteLength} bytes over cap ${MAX_IMAGE_BYTES}`);
  }
  if (bytes.byteLength === 0) throw new DeadImageError(`GET ${url} → empty body`);

  return {
    blob: new Blob([bytes], { type: contentType }),
    filename: imageFilename(url, contentType),
    bytes: bytes.byteLength,
    data: bytes,
  };
}

/**
 * Fetch an image and refuse it unless it clears the lead floor. The common
 * case for a story's hero: URL heuristics let a 200x200 graphic reach a splash,
 * and only the bytes settle it. Dead, not transient — the file will never grow.
 */
export async function downloadLeadImage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<DownloadedImage> {
  const image = await downloadImage(url, fetchImpl);
  const dims = imageDims(image.data);
  if (!meetsLeadFloor(dims)) {
    const seen = dims === null ? "unknown size" : `${dims.width}x${dims.height}`;
    throw new DeadImageError(`GET ${url} → ${seen}, under the ${MIN_LEAD_PX}px lead floor`);
  }
  return image;
}
