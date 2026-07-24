/**
 * lead-image.checks.ts — extractOgImage parsing + junk/branded rejection,
 * searchGoogleImages result shaping over a fake fetch, and pickLeadImage's
 * source-first-then-search preference. Plus one live smoke against the real
 * proxy (SKIPs without IMAGE_SEARCH_URL/IMAGE_SEARCH_KEY — CI has no key).
 * Run: npx tsx sources/lead-image.checks.ts
 */
import { extractOgImage, fetchOgImage, pickLeadImage, searchGoogleImages } from "./lead-image";
import type { ImageSearchConfig } from "./lead-image";

let failures = 0;
const ok = (name: string, cond: boolean, detail: string): void => {
  if (cond) process.stdout.write(`PASS ${name}\n`);
  else {
    failures += 1;
    process.stdout.write(`FAIL ${name} — ${detail}\n`);
  }
};

const fakeFetch = (routes: Record<string, { status?: number; body: string }>): typeof fetch =>
  (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const hit = routes[url];
    if (hit === undefined) return new Response("not found", { status: 404 });
    return new Response(hit.body, { status: hit.status ?? 200 });
  }) as typeof fetch;

const CFG: ImageSearchConfig = { url: "https://proxy.example/api/searxng/search", apiKey: "k" };
const SEARCH = `https://proxy.example/api/searxng/search?q=ukraine%20military&type=images&engines=google%20images&num=10`;

async function main(): Promise<void> {
  // extractOgImage — finds og:image regardless of attribute order.
  ok(
    "extractOgImage finds og:image (content before property)",
    extractOgImage('<meta content="https://cdn.news/photo.jpg" property="og:image">') ===
      "https://cdn.news/photo.jpg",
    "attr-order parse",
  );
  ok(
    "extractOgImage finds og:image (property before content)",
    extractOgImage('<meta property="og:image" content="https://cdn.news/story.jpg" />') ===
      "https://cdn.news/story.jpg",
    "standard order",
  );
  ok(
    "extractOgImage falls back to twitter:image",
    extractOgImage('<meta name="twitter:image" content="https://cdn.news/tw.png">') ===
      "https://cdn.news/tw.png",
    "twitter fallback",
  );
  ok(
    "extractOgImage REJECTS a logo/default social card",
    extractOgImage('<meta property="og:image" content="https://site.com/images/logo_social.png">') === null,
    "junk rejected",
  );
  ok("extractOgImage null when no image meta", extractOgImage("<html><head></head></html>") === null, "no meta");

  // Branded-host rejection: a Guardian og:image ships the outlet's live-blog
  // overlay in the pixels (operator rule 2026-07-24: "don't take guardian
  // images") — skip it and let a clean twitter:image (or the next source) win.
  const guardianHtml =
    `<meta property="og:image" content="https://i.guim.co.uk/img/media/abc/master/4153.jpg">` +
    `<meta name="twitter:image" content="https://cdn.other.example/photo.jpg">`;
  ok(
    "guim.co.uk og:image rejected, clean twitter:image wins",
    extractOgImage(guardianHtml) === "https://cdn.other.example/photo.jpg",
    String(extractOgImage(guardianHtml)),
  );
  ok(
    "page with ONLY a Guardian image yields null (falls to next source/search)",
    extractOgImage(`<meta property="og:image" content="https://media.guim.co.uk/x/photo.jpg">`) === null,
    "expected null",
  );

  // searchGoogleImages — first usable hit wins; page host is the credit.
  const searchFetch = fakeFetch({
    [SEARCH]: {
      body: JSON.stringify({
        results: [
          { url: "https://www.theguardian.com/world/live/x", title: "g", imgSrc: "https://i.guim.co.uk/img/a.jpg" },
          { url: "https://www.reuters.com/world/story", title: "r", imgSrc: "https://cdn.reuters.example/photo.jpg" },
        ],
      }),
    },
  });
  const found = await searchGoogleImages("ukraine military", CFG, searchFetch);
  ok(
    "searchGoogleImages skips branded hits, credits the page host, source=search",
    found !== null &&
      found.url === "https://cdn.reuters.example/photo.jpg" &&
      found.credit === "reuters.com" &&
      found.source === "search",
    JSON.stringify(found),
  );
  ok("searchGoogleImages null on empty results", (await searchGoogleImages("ukraine military", CFG, fakeFetch({ [SEARCH]: { body: '{"results":[]}' } }))) === null, "empty");
  ok("searchGoogleImages null on HTTP error (no throw)", (await searchGoogleImages("ukraine military", CFG, fakeFetch({}))) === null, "404");

  // fetchOgImage — best-effort, never throws.
  const pageFetch = fakeFetch({
    "https://outlet.example/story": { body: '<meta property="og:image" content="https://outlet.example/lead.jpg">' },
  });
  ok(
    "fetchOgImage reads a live page's og:image",
    (await fetchOgImage("https://outlet.example/story", pageFetch)) === "https://outlet.example/lead.jpg",
    "page og",
  );
  ok("fetchOgImage null on 404 (no throw)", (await fetchOgImage("https://outlet.example/missing", pageFetch)) === null, "404");

  // pickLeadImage — source og:image wins over the search.
  const both = fakeFetch({
    "https://a.example/1": { body: '<meta property="og:image" content="https://a.example/photo.jpg">' },
    [SEARCH]: { body: JSON.stringify({ results: [{ url: "https://p.example/s", imgSrc: "https://img.example/g.jpg" }] }) },
  });
  const preferSource = await pickLeadImage({ sourceUrls: ["https://a.example/1"], query: "ukraine military", imageSearch: CFG, fetchImpl: both });
  ok(
    "pickLeadImage prefers a source og:image (source, host credit)",
    preferSource !== null && preferSource.url === "https://a.example/photo.jpg" && preferSource.source === "source" && preferSource.credit === "a.example",
    JSON.stringify(preferSource),
  );

  // pickLeadImage — all sources dry → Google Images through the proxy.
  const fallback = fakeFetch({
    "https://dead.example/1": { status: 500, body: "" },
    [SEARCH]: { body: JSON.stringify({ results: [{ url: "https://p.example/s", imgSrc: "https://img.example/g.jpg" }] }) },
  });
  const fell = await pickLeadImage({ sourceUrls: ["https://dead.example/1"], query: "ukraine military", imageSearch: CFG, fetchImpl: fallback });
  ok(
    "pickLeadImage falls back to the image search when sources yield nothing",
    fell !== null && fell.url === "https://img.example/g.jpg" && fell.source === "search",
    JSON.stringify(fell),
  );

  // No config → no search call, null (the desk publishes imageless).
  const noCfg = await pickLeadImage({ sourceUrls: ["https://dead.example/1"], query: "ukraine military", fetchImpl: fallback });
  ok("pickLeadImage without imageSearch config stops at null", noCfg === null, JSON.stringify(noCfg));

  // Live smoke: the real proxy, real google images engine. SKIP without keys.
  const liveUrl = process.env.IMAGE_SEARCH_URL;
  const liveKey = process.env.IMAGE_SEARCH_KEY;
  if (liveUrl === undefined || liveKey === undefined || liveUrl === "" || liveKey === "") {
    process.stdout.write("SKIP live google-images smoke — IMAGE_SEARCH_URL/IMAGE_SEARCH_KEY not set\n");
  } else {
    const live = await searchGoogleImages("wildfire france", { url: liveUrl, apiKey: liveKey }, globalThis.fetch);
    ok(
      "LIVE google images returns a usable unbranded photo",
      live !== null && live.url.startsWith("http") && !live.url.includes("guim.co.uk"),
      JSON.stringify(live),
    );
  }

  if (failures > 0) {
    process.exitCode = 1;
    process.stdout.write(`lead-image checks: ${failures} FAILED\n`);
    return;
  }
  process.stdout.write("lead-image checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`lead-image.checks failed: ${String(err)}\n`);
  process.exit(1);
});
