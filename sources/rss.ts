/**
 * RssSource — a generic built-in `Source` that turns RSS/Atom feeds into a
 * `DiscoverySignal`. The reference build's "bring a feed, get a signal" adapter
 * (Layer 3 made trivial).
 *
 * It owns its OWN configured `rss-parser` instance — a standalone,
 * domain-agnostic Source, distinct from the engine's internal `news.ts` research
 * helper. Each feed is parsed and its items mapped onto `SignalItem`:
 *
 *   item.contentSnippet → summary   (plain-text snippet, not raw HTML)
 *   item.link           → url
 *   item.isoDate        → date      (normalized ISO 8601)
 *   item.title          → title
 *
 * `entities` is left empty: the contract says the Linker re-extracts typed
 * entities from the finished article, so a feed needn't classify them.
 *
 * The `parser` is exposed on the returned object so callers (and tests) can
 * reach the configured instance; feeds are concatenated in order.
 *
 * Imports only `./ports` + the pure `rss-parser` lib — nothing from a host app, no SDKs.
 */
import Parser from "rss-parser";
import type { DiscoverySignal, SignalItem, Source } from "../ports";

export interface RssSourceConfig {
  /** Feed URLs to pull, parsed + concatenated in order. */
  feeds: string[];
}

/** A `Source` that also surfaces its configured `rss-parser` instance. */
export interface RssSource extends Source {
  readonly parser: Parser;
}

/** Map one rss-parser item onto the engine's `SignalItem`. */
function itemToSignal(item: Parser.Item): SignalItem {
  return {
    title: item.title ?? "",
    summary: item.contentSnippet ?? "",
    entities: [],
    date: item.isoDate,
    url: item.link,
  };
}

export function createRssSource(cfg: RssSourceConfig): RssSource {
  const parser = new Parser();

  return {
    parser,
    async gatherSignal(): Promise<DiscoverySignal> {
      const items: SignalItem[] = [];
      for (const feed of cfg.feeds) {
        const parsed = await parser.parseURL(feed);
        for (const item of parsed.items) {
          items.push(itemToSignal(item));
        }
      }
      return { items };
    },
  };
}
