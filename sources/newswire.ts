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
  const parseFeed = opts.parseFeed ?? ((url: string) => parser.parseURL(url));
  return {
    async buildIndex(): Promise<OutletItem[]> {
      const limit = pLimit(opts.concurrency);
      const perFeed = await Promise.all(
        opts.feeds.map((feed) =>
          limit(async (): Promise<OutletItem[]> => {
            try {
              const parsed = await parseFeed(feed.url);
              return parsed.items
                .filter((i) => (i.title ?? "") !== "" && (i.link ?? "") !== "")
                .map((i) => ({
                  outlet: feed.outlet,
                  region: feed.region,
                  title: (i.title ?? "").trim(),
                  url: (i.link ?? "").trim(),
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
