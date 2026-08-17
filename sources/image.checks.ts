/**
 * image.checks.ts — the URL verdict, the header parsers and the fetch gates.
 * Run: npx tsx sources/image.checks.ts
 *
 * Nearly every case here is a photo that was WRONGLY REJECTED or WRONGLY
 * ACCEPTED in production. The negative cases matter as much as the positive
 * ones: three separate over-eager filters (getty, pixel, 1200x630) each binned
 * dozens of clean press photos before they were narrowed.
 */
import {
  DeadImageError,
  downloadImage,
  downloadLeadImage,
  imageDims,
  imageFilename,
  isBrandedImageHost,
  keepImage,
  meetsLeadFloor,
  MIN_LEAD_PX,
  normalizeImageUrl,
} from "./image";

/** A minimal but REAL file header for each format, built byte-exact. */
function pngOf(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(b.buffer).setUint32(16, w, false);
  new DataView(b.buffer).setUint32(20, h, false);
  return b;
}
function gifOf(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  new DataView(b.buffer).setUint16(6, w, true);
  new DataView(b.buffer).setUint16(8, h, true);
  return b;
}
function jpegOf(w: number, h: number): Uint8Array {
  // SOI, a COM segment to prove the marker walk skips payloads, then SOF0.
  const b = new Uint8Array(40);
  b.set([0xff, 0xd8], 0);
  b.set([0xff, 0xfe, 0x00, 0x04, 0x41, 0x42], 2); // COM, length 4
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 8); // SOF0, len 17, precision 8
  new DataView(b.buffer).setUint16(13, h, false);
  new DataView(b.buffer).setUint16(15, w, false);
  return b;
}
function webpVp8Of(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  new DataView(b.buffer).setUint16(26, w, true);
  new DataView(b.buffer).setUint16(28, h, true);
  return b;
}

function res(body: Uint8Array, type: string, status: number, extra?: Record<string, string>): Response {
  return new Response(status === 204 ? null : body, {
    status,
    headers: { "content-type": type, ...(extra ?? {}) },
  });
}

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  // ── normalizeImageUrl ────────────────────────────────────────────────────
  ok(
    "&amp; in a scraped og:image is unescaped (a CDN reads it as one giant param and 400s)",
    normalizeImageUrl("https://cdn.x/i.jpg?a=1&amp;width=1200", undefined) === "https://cdn.x/i.jpg?a=1&width=1200",
    normalizeImageUrl("https://cdn.x/i.jpg?a=1&amp;width=1200", undefined),
  );
  ok(
    "a raw space is percent-encoded (it failed URL validation and wedged a sweep)",
    normalizeImageUrl("https://cdn.x/Nintendo Direct/a.jpg", undefined) === "https://cdn.x/Nintendo%20Direct/a.jpg",
    normalizeImageUrl("https://cdn.x/Nintendo Direct/a.jpg", undefined),
  );
  ok(
    "existing %XX is not double-encoded",
    normalizeImageUrl("https://cdn.x/a%20b.jpg", undefined) === "https://cdn.x/a%20b.jpg",
    normalizeImageUrl("https://cdn.x/a%20b.jpg", undefined),
  );
  ok("a relative src resolves against base",
    normalizeImageUrl("/img/a.jpg", "https://site.com/story") === "https://site.com/img/a.jpg",
    normalizeImageUrl("/img/a.jpg", "https://site.com/story"));
  ok("non-http(s) yields ''", normalizeImageUrl("data:image/png;base64,AAA", undefined) === "", "");
  ok("unparseable yields ''", normalizeImageUrl("!! not a url", undefined) === "", "");

  // ── keepImage: the ACCEPTS that earlier filters broke ────────────────────
  ok("an outlet CDN copy naming a getty asset is KEPT (substring 'getty' binned 66 clean photos)",
    keepImage("https://image.cnbcfm.com/api/v1/image/107-gettyimages-2226607379-x.jpeg"), "");
  ok("a Google Pixel photo is KEPT (a 'pixel' token binned every one)",
    keepImage("https://cdn.outlet.com/2026/google-pixel-10-review.jpg"), "");
  ok("a real photo at the 1200x630 social crop is KEPT (that rule lost 15 leads)",
    keepImage("https://media.cbs.com/2026/08/story-1200x630.jpg"), "");
  ok("SEMICON in a filename is KEPT ('icon' as a bare substring rejected it)",
    keepImage("https://image.cnbcfm.com/api/v1/image/semicon-china-2026.jpg"), "");
  ok("a Wikimedia SVG rendered to a big PNG is KEPT",
    keepImage("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Flag.svg/1280px-Flag.svg.png"), "");
  ok("a large aspect-ratio token does not read as a size",
    keepImage("https://cdn.x/photo.jpg?c=16x9&w=1600"), "");

  // ── keepImage: the REJECTS ───────────────────────────────────────────────
  ok("a stock agency's own host is rejected (watermarked previews)",
    !keepImage("https://www.gettyimages.com/detail/photo/x-123.jpg"), "");
  ok("a stock subdomain is rejected", !keepImage("https://media.shutterstock.com/x.jpg"), "");
  ok("a bare .svg is rejected", !keepImage("https://site.com/brand/mark.svg"), "");
  ok("an extensionless /svg generator endpoint is rejected",
    !keepImage("https://api.dicebear.com/9.x/notionists/svg"), "");
  ok("an animated .gif is rejected", !keepImage("https://site.com/anim.gif"), "");
  ok("a logo is rejected", !keepImage("https://site.com/assets/logo-wide.png"), "");
  ok("an /icon/ path token is rejected", !keepImage("https://site.com/icon/share.png"), "");
  ok("a townnews/bloximages station card is rejected",
    !keepImage("https://bloximages.chicago2.vip.townnews.com/x/card.jpg"), "");
  ok("a facebook-default og card is rejected",
    !keepImage("https://media.npr.org/facebook-default-widget.jpg"), "");
  ok("a 150x150 path thumbnail is rejected", !keepImage("https://site.com/img/a-150x150.jpg"), "");
  ok("a ?w=60 query thumbnail is rejected", !keepImage("https://site.com/a.jpg?w=60&h=60"), "");
  ok("a small CDN transform is rejected", !keepImage("https://res.cdn.com/w_120,h_120/a.jpg"), "");
  ok("a small Wikimedia scale is rejected",
    !keepImage("https://upload.wikimedia.org/w/thumb/a/ab/F.jpg/120px-F.jpg"), "");
  ok("a 60x60 resize OUTPUT beats a big source crop (the avatar case)",
    !keepImage("https://dims.apnews.com/crop/2558x2558/resize/60x60/a.jpg"), "");
  ok("a non-http scheme is rejected", !keepImage("ftp://site.com/a.jpg"), "");
  ok("branded image hosts are flagged", isBrandedImageHost("https://i.guim.co.uk/img/media/x.jpg"), "");
  ok("a normal host is not flagged", !isBrandedImageHost("https://media.cbs.com/x.jpg"), "");

  // ── imageDims: real headers of each format ───────────────────────────────
  ok("PNG dims", JSON.stringify(imageDims(pngOf(1600, 900))) === '{"width":1600,"height":900}',
    JSON.stringify(imageDims(pngOf(1600, 900))));
  ok("GIF dims (little-endian)", JSON.stringify(imageDims(gifOf(640, 480))) === '{"width":640,"height":480}',
    JSON.stringify(imageDims(gifOf(640, 480))));
  ok("JPEG dims, walking past a COM segment to SOF0",
    JSON.stringify(imageDims(jpegOf(1920, 1080))) === '{"height":1080,"width":1920}',
    JSON.stringify(imageDims(jpegOf(1920, 1080))));
  ok("WebP VP8 dims mask off the 2 high bits",
    JSON.stringify(imageDims(webpVp8Of(1200, 800))) === '{"width":1200,"height":800}',
    JSON.stringify(imageDims(webpVp8Of(1200, 800))));
  ok("an unrecognized format yields null, it does not throw",
    imageDims(new Uint8Array(40)) === null, "");
  ok("a too-short buffer yields null", imageDims(new Uint8Array(4)) === null, "");
  // The offset case: a Uint8Array VIEW into a larger buffer must not read the
  // wrong bytes — this is what Buffer.from(data.buffer) got wrong.
  {
    const backing = new Uint8Array(80);
    backing.set(pngOf(1024, 768), 40);
    const view = backing.subarray(40);
    ok("a subarray view reads its own bytes, not the backing buffer's start",
      JSON.stringify(imageDims(view)) === '{"width":1024,"height":768}', JSON.stringify(imageDims(view)));
  }

  // ── the lead floor ───────────────────────────────────────────────────────
  ok("800px exactly clears the floor", meetsLeadFloor({ width: 800, height: 200 }), "");
  ok("799px does not", !meetsLeadFloor({ width: 799, height: 799 }), "");
  ok("judged on the LONGEST side: a 490x665 portrait is refused on its 665",
    !meetsLeadFloor({ width: 490, height: 665 }), "");
  ok("null (unrecognized format) passes un-judged rather than rejecting blind",
    meetsLeadFloor(null), "");
  ok("the floor is 800", MIN_LEAD_PX === 800, String(MIN_LEAD_PX));

  // ── imageFilename ────────────────────────────────────────────────────────
  ok("a sane source filename is kept", imageFilename("https://x.com/a/photo.jpg", "image/jpeg") === "photo.jpg",
    imageFilename("https://x.com/a/photo.jpg", "image/jpeg"));
  ok("an extensionless path gains the content-type's extension",
    imageFilename("https://x.com/a/original", "image/webp") === "original.webp",
    imageFilename("https://x.com/a/original", "image/webp"));
  ok("unsafe characters are stripped",
    /^[A-Za-z0-9._-]+$/.test(imageFilename("https://x.com/a/pho to!.jpg", "image/jpeg")),
    imageFilename("https://x.com/a/pho to!.jpg", "image/jpeg"));

  // ── downloadImage: the fetch gates ───────────────────────────────────────
  const png = pngOf(1600, 900);
  const okFetch = (async () => res(png, "image/png", 200)) as unknown as typeof fetch;
  const got = await downloadImage("https://x.com/a.png", okFetch);
  ok("a good image downloads with bytes, blob and filename",
    got.bytes === png.byteLength && got.filename === "a.png" && got.data.byteLength === png.byteLength,
    JSON.stringify({ bytes: got.bytes, filename: got.filename }));

  const dead = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
      return "(did not throw)";
    } catch (err: unknown) {
      return err instanceof DeadImageError ? "dead" : `other:${(err as Error).name}`;
    }
  };
  ok("a 404 is DeadImageError (callers drop the URL)",
    (await dead(() => downloadImage("https://x.com/a.png", (async () => res(png, "image/png", 404)) as unknown as typeof fetch))) === "dead", "");
  ok("HTML served for an image URL is DeadImageError",
    (await dead(() => downloadImage("https://x.com/a.png", (async () => res(png, "text/html", 200)) as unknown as typeof fetch))) === "dead", "");
  ok("SVG is refused by content-type even if the URL looked fine",
    (await dead(() => downloadImage("https://x.com/a.png", (async () => res(png, "image/svg+xml", 200)) as unknown as typeof fetch))) === "dead", "");
  ok("an empty body is DeadImageError",
    (await dead(() => downloadImage("https://x.com/a.png", (async () => res(new Uint8Array(0), "image/png", 200)) as unknown as typeof fetch))) === "dead", "");
  ok("an unusable URL is DeadImageError before any fetch",
    (await dead(() => downloadImage("!! not a url", okFetch))) === "dead", "");
  // Over-cap is a PLAIN Error, not Dead: the URL may be fine, the file is just big.
  ok("an over-cap content-length is a transient Error, NOT DeadImageError",
    (await dead(() =>
      downloadImage("https://x.com/a.png", (async () =>
        res(png, "image/png", 200, { "content-length": String(9 * 1024 * 1024) })) as unknown as typeof fetch),
    )) === "other:Error", "");

  // ── downloadLeadImage: the pixel floor, applied to real bytes ────────────
  const small = pngOf(300, 200);
  ok("a 300x200 file is refused as a lead even though its URL looked clean",
    (await dead(() => downloadLeadImage("https://x.com/a.png", (async () => res(small, "image/png", 200)) as unknown as typeof fetch))) === "dead", "");
  const big = await downloadLeadImage("https://x.com/a.png", okFetch);
  ok("a 1600x900 file passes the lead floor", big.bytes === png.byteLength, String(big.bytes));
  // downloadImage must NOT apply the floor — a gallery photo may be small.
  const smallOk = await downloadImage("https://x.com/a.png", (async () => res(small, "image/png", 200)) as unknown as typeof fetch);
  ok("downloadImage does NOT apply the lead floor (gallery photos may be small)",
    smallOk.bytes === small.byteLength, String(smallOk.bytes));

  if (failures > 0) {
    process.stdout.write(`\n${failures} image check(s) failed\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("image checks: all green\n");
}
main().catch((err: unknown) => {
  process.stderr.write(`image.checks failed: ${String(err)}\n`);
  process.exit(1);
});
