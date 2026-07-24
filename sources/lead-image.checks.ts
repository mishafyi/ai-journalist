/**
 * lead-image.checks.ts — extractOgImage parsing + junk rejection,
 * searchOpenverse credit shaping over a fake fetch, and pickLeadImage's
 * source-first-then-Openverse preference. Run: npx tsx sources/lead-image.checks.ts
 */
import { extractOgImage, fetchOgImage, pickLeadImage, searchOpenverse } from "./lead-image";

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

  // searchOpenverse — shapes a credit string from the first usable result.
  const OV = "https://api.openverse.org/v1/images/?q=ukraine%20military&page_size=3&mature=false&extension=jpg,jpeg,png,webp";
  const ovFetch = fakeFetch({
    [OV]: {
      body: JSON.stringify({
        results: [
          { url: "https://live.example/photo.jpg", title: "Kyiv at dawn", creator: "A. Photographer", license: "by" },
        ],
      }),
    },
  });
  const ov = await searchOpenverse("ukraine military", ovFetch);
  ok(
    "searchOpenverse returns url + shaped credit + openverse source",
    ov !== null &&
      ov.url === "https://live.example/photo.jpg" &&
      ov.credit === "Kyiv at dawn — A. Photographer (by) via Openverse" &&
      ov.source === "openverse",
    JSON.stringify(ov),
  );
  ok("searchOpenverse null on empty results", (await searchOpenverse("x", fakeFetch({}))) === null, "empty");

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

  // pickLeadImage — source og:image wins over Openverse.
  const both = fakeFetch({
    "https://a.example/1": { body: '<meta property="og:image" content="https://a.example/photo.jpg">' },
    [OV]: { body: JSON.stringify({ results: [{ url: "https://ov.example/cc.jpg", title: "t", license: "cc0" }] }) },
  });
  const preferSource = await pickLeadImage({ sourceUrls: ["https://a.example/1"], query: "ukraine military", fetchImpl: both });
  ok(
    "pickLeadImage prefers a source og:image (source, host credit)",
    preferSource !== null && preferSource.url === "https://a.example/photo.jpg" && preferSource.source === "source" && preferSource.credit === "a.example",
    JSON.stringify(preferSource),
  );

  // pickLeadImage — all sources dry → Openverse fallback.
  const fallback = fakeFetch({
    "https://dead.example/1": { status: 500, body: "" },
    [OV]: { body: JSON.stringify({ results: [{ url: "https://ov.example/cc.jpg", title: "War", license: "cc0" }] }) },
  });
  const fell = await pickLeadImage({ sourceUrls: ["https://dead.example/1"], query: "ukraine military", fetchImpl: fallback });
  ok(
    "pickLeadImage falls back to Openverse when sources yield nothing",
    fell !== null && fell.url === "https://ov.example/cc.jpg" && fell.source === "openverse",
    JSON.stringify(fell),
  );

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
