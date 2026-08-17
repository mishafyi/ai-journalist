/**
 * Curated outlet feeds → a headline→URL index for coverage resolution. The
 * feed list IS the scrape allowlist (spec). Deliberately NOT rss.ts's
 * pattern: parallel (p-limit), per-feed best-effort with loud logging,
 * explicit timeout — with 10–15 feeds, one dead outlet must never kill the
 * signal, and serial fetching is the slowest step of a run.
 */
import Parser from "rss-parser";
import pLimit from "p-limit";

export interface OutletFeed {
  url: string;
  outlet: string;
  region: string;
}

export interface OutletItem {
  outlet: string;
  region: string;
  title: string;
  url: string;
  date?: string;
}

export function createNewswire(opts: {
  feeds: readonly OutletFeed[];
  concurrency: number;
  timeoutMs: number;
  log?: (line: string) => void;
  parseFeed?: (url: string) => Promise<{ items: { title?: string; link?: string; isoDate?: string }[] }>;
}): { buildIndex(): Promise<OutletItem[]> } {
  const parser = new Parser({ timeout: opts.timeoutMs });
  // parseURL uses rss-parser's own http client, which hands back RAW GZIP for
  // a server that compresses unasked (Middle East Eye did, and the parse died
  // on "Non-whitespace before first tag"). Global fetch decompresses per the
  // Content-Encoding header, so the bytes reach the parser as text. It also
  // lets us send a browser UA, which several feeds require.
  const parseFeed =
    opts.parseFeed ??
    (async (url: string) => {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parser.parseString(await res.text());
    });
  return {
    async buildIndex(): Promise<OutletItem[]> {
      const limit = pLimit(opts.concurrency);
      const perFeed = await Promise.all(
        opts.feeds.map((feed) =>
          limit(async (): Promise<OutletItem[]> => {
            try {
              const parsed = await parseFeed(feed.url);
              return parsed.items
                // String(): a feed can hand back a non-string title (an
                // object, when the "feed" is really a redirect page) and
                // .trim() then throws, killing that whole outlet.
                .map((i) => ({ ...i, title: String(i.title ?? ""), link: String(i.link ?? "") }))
                .filter((i) => i.title !== "" && i.link !== "")
                .map((i) => ({
                  outlet: feed.outlet,
                  region: feed.region,
                  title: i.title.trim(),
                  url: i.link.trim(),
                  ...(i.isoDate === undefined ? {} : { date: i.isoDate }),
                }));
            } catch (err: unknown) {
              opts.log?.(`newswire: feed FAILED ${feed.outlet} (${feed.url}): ${String(err)}`);
              return [];
            }
          }),
        ),
      );
      return perFeed.flat();
    },
  };
}
