/**
 * Reference `Source` library barrel — the built-in adopters that implement the
 * input `Source` port so "plug any data in" is config, not code:
 *
 *   - `createHttpSource` — point it at an endpoint returning DiscoverySignal /
 *     GroundingFacts (or bridge any shape with `mapSignal`).
 *   - `createRssSource`  — build the signal from RSS/Atom feeds.
 *   - `createFileSource` — read the signal / facts from local JSON files.
 *   - `composeSources`   — merge several Sources into one.
 *
 * (The OUTPUT — `publish(post)` — is always adopter-implemented; no Sink class
 * ships. See the README.)
 */
export { createHttpSource, type HttpSourceConfig } from "./http";
export { createRssSource, type RssSource, type RssSourceConfig } from "./rss";
export { createFileSource, type FileSourceConfig } from "./file";
export { composeSources } from "./compose";
export {
  fetchTrendingStories,
  parseTrending,
  googleNewsTopUrl,
  fetchTopicStories,
  parseTopicStories,
  dedupeTrending,
  googleNewsTopicUrl,
  GN_TOPICS,
  GN_US,
  type GnTopic,
  type GnEdition,
  type TrendingStory,
  type CoverageEntry,
} from "./google-news";
export { createNewswire, type OutletFeed, type OutletItem } from "./newswire";
