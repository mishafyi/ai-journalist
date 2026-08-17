/**
 * gallery.checks.ts — the trust split, the dedupe key, and page selection.
 * Run: npx tsx sources/gallery.checks.ts
 *
 * The meta/body split is the whole point of the module, so most of these guard
 * it: an off-topic recirculation thumbnail must never outrank the outlet's own
 * photo of the story.
 */
import {
  collectSourcePages,
  dedupeKey,
  extractImages,
  harvestPages,
  pickGallery,
} from "./gallery";

const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  // ── dedupeKey: the same photo at several sizes is ONE photo ──────────────
  ok("two widths of the same file collapse",
    dedupeKey("https://cdn.x/w:1280/photo.jpg") === dedupeKey("https://cdn.x/w:388/photo.jpg"),
    `${dedupeKey("https://cdn.x/w:1280/photo.jpg")} vs ${dedupeKey("https://cdn.x/w:388/photo.jpg")}`);
  ok("a resizer's inner ?url= original beats the wrapper",
    dedupeKey("https://dims.apnews.com/x/resize/1200x800/?url=https%3A%2F%2Fs3.aws.com%2Fabc%2Fphoto.jpg")
      === "photo.jpg",
    dedupeKey("https://dims.apnews.com/x/resize/1200x800/?url=https%3A%2F%2Fs3.aws.com%2Fabc%2Fphoto.jpg"));
  ok("different photos stay different",
    dedupeKey("https://cdn.x/a.jpg") !== dedupeKey("https://cdn.x/b.jpg"), "");
  ok("a query string alone does not make a new photo",
    dedupeKey("https://cdn.x/a.jpg?v=1") === dedupeKey("https://cdn.x/a.jpg?v=2"), "");
  ok("an unparseable url degrades to itself rather than throwing",
    dedupeKey("not a url") === "not a url", dedupeKey("not a url"));

  // ── extractImages: the trust split ───────────────────────────────────────
  {
    const page = `
      <meta property="og:image" content="https://cdn.out/story-hero.jpg?a=1&amp;w=1200">
      <meta name="twitter:image" content="https://cdn.out/story-alt.jpg">
      <img src="/rel/body-one.jpg">
      <img data-src="https://cdn.out/lazy.jpg" src="https://cdn.out/placeholder.png">
      <img srcset="https://cdn.out/wide.jpg 1200w, https://cdn.out/small.jpg 400w">
    `;
    const got = extractImages(page, "https://out.com/2026/story");
    ok("og:image and twitter:image land in meta",
      got.meta.length === 2 && got.meta[0].includes("story-hero"), JSON.stringify(got.meta));
    ok("&amp; in a scraped attribute is unescaped (it 400s otherwise)",
      got.meta[0] === "https://cdn.out/story-hero.jpg?a=1&w=1200", got.meta[0]);
    ok("a relative body src is absolutized against the page",
      got.body.includes("https://out.com/rel/body-one.jpg"), JSON.stringify(got.body));
    ok("data-src (lazy loading) is read, not just src",
      got.body.includes("https://cdn.out/lazy.jpg"), JSON.stringify(got.body));
    ok("the first srcset candidate is taken without its width descriptor",
      got.body.includes("https://cdn.out/wide.jpg"), JSON.stringify(got.body));
    ok("body images never leak into meta",
      got.meta.every((u) => !u.includes("body-one") && !u.includes("lazy")), JSON.stringify(got.meta));
  }
  ok("a page with no images yields two empty buckets, not a throw",
    (() => {
      const g = extractImages("<html><body><p>text</p></body></html>", "https://x.com/a");
      return g.meta.length === 0 && g.body.length === 0;
    })(), "");

  // ── collectSourcePages ───────────────────────────────────────────────────
  {
    const pages = collectSourcePages({
      sourceUrls: ["https://www.bbc.com/news/one", "https://apnews.com/article/two"],
      markdown: "See [the Guardian](https://www.theguardian.com/world/three) and https://www.bbc.com/news/four",
      ownHosts: ["mypaper.example"],
      limit: 6,
    });
    ok("structured sources and body links are UNIONed",
      pages.length === 3, JSON.stringify(pages));
    ok("one page per host — an outlet is fetched once, not five times",
      pages.filter((p) => p.includes("bbc.com")).length === 1, JSON.stringify(pages));
  }
  {
    const pages = collectSourcePages({
      sourceUrls: [],
      markdown: "read more at https://mypaper.example/2026/our-own-story and https://sub.mypaper.example/x",
      ownHosts: ["mypaper.example"],
      limit: 6,
    });
    ok("a story never harvests itself, including its own subdomains",
      pages.length === 0, JSON.stringify(pages));
  }
  {
    const pages = collectSourcePages({
      sourceUrls: [
        "https://x.com/someone/status/1",
        "https://www.youtube.com/watch?v=abc",
        "https://ground.news/article/x",
        "https://quickchart.io/chart?c=1",
        "https://www.reuters.com/world/real",
      ],
      markdown: "",
      ownHosts: ["mypaper.example"],
      limit: 6,
    });
    ok("deny-tier hosts and chart services are dropped, real outlets kept",
      pages.length === 1 && pages[0].includes("reuters.com"), JSON.stringify(pages));
  }
  ok("the page cap is honoured",
    collectSourcePages({
      sourceUrls: ["https://a.com/1", "https://b.com/1", "https://c.com/1", "https://d.com/1"],
      markdown: "",
      ownHosts: [],
      limit: 2,
    }).length === 2, "");

  // ── harvestPages: dedupe across pages, junk filtered, nothing throws ─────
  {
    const pages: Record<string, string> = {
      "https://one.com/story": `
        <meta property="og:image" content="https://cdn.one/hero.jpg">
        <img src="https://cdn.one/logo.png">
        <img src="https://cdn.one/rail-thumb.jpg">`,
      // Second outlet serves THE SAME photo at another width — must collapse.
      "https://two.com/story": `
        <meta property="og:image" content="https://cdn.one/w:400/hero.jpg">
        <img src="https://cdn.two/second-body.jpg">`,
    };
    const fetchImpl = (async (url: string | URL) => {
      const body = pages[String(url)];
      return body === undefined ? new Response("", { status: 404 }) : html(body);
    }) as unknown as typeof fetch;

    const got = await harvestPages(Object.keys(pages), { fetchImpl });
    ok("meta photos are collected and credited to the page host",
      got.meta.length === 1 && got.meta[0].credit === "one.com", JSON.stringify(got.meta));
    ok("the same photo at another width does not appear twice",
      got.meta.filter((p) => p.url.includes("hero")).length === 1, JSON.stringify(got.meta));
    ok("a logo is filtered out of body by keepImage",
      got.body.every((p) => !p.url.includes("logo")), JSON.stringify(got.body));
    ok("found counts everything seen, before filtering",
      got.found > got.meta.length + got.body.length, String(got.found));
  }
  {
    // The lead must not come back as a slide, even via a different size.
    const fetchImpl = (async () =>
      html(`<meta property="og:image" content="https://cdn.x/w:1200/lead.jpg">`)) as unknown as typeof fetch;
    const got = await harvestPages(["https://a.com/s"], {
      fetchImpl,
      exclude: "https://cdn.x/w:400/lead.jpg",
    });
    ok("the excluded lead is not re-offered, even at another size",
      got.meta.length === 0, JSON.stringify(got.meta));
  }
  {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const got = await harvestPages(["https://a.com/s"], { fetchImpl });
    ok("a page that throws is survivable — harvest never propagates it",
      got.meta.length === 0 && got.body.length === 0, "");
  }
  {
    // A JSON answer to an article URL is not a page to scrape.
    const fetchImpl = (async () =>
      new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const got = await harvestPages(["https://a.com/s"], { fetchImpl });
    ok("a non-HTML content-type is skipped rather than regex-scraped",
      got.found === 0, String(got.found));
  }

  // ── pickGallery: meta first, body only as top-up ─────────────────────────
  {
    const meta = [{ url: "m1", credit: "c" }, { url: "m2", credit: "c" }];
    const body = [{ url: "b1", credit: "c" }];
    ok("meta alone when it can fill the set — no off-topic rail thumbnails",
      JSON.stringify(pickGallery({ found: 3, meta, body }, 2).map((p) => p.url)) === '["m1","m2"]', "");
    ok("body tops up only when meta cannot fill it",
      JSON.stringify(pickGallery({ found: 3, meta, body }, 3).map((p) => p.url)) === '["m1","m2","b1"]', "");
    ok("returns short rather than padding with what it does not trust",
      pickGallery({ found: 0, meta: [], body: [] }, 4).length === 0, "");
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} gallery check(s) failed\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("gallery checks: all green\n");
}
main().catch((err: unknown) => {
  process.stderr.write(`gallery.checks failed: ${String(err)}\n`);
  process.exit(1);
});
