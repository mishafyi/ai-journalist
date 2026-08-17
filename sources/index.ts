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
 * Also re-exported here so `from "ai-journalist/sources"` reaches them:
 * `provenance` (is this host a real outlet?), `lead-image` (one hero per
 * story), `image` (is this a usable photo, and how big is it?) and `gallery`
 * (every photo on the pages a story cites). Each also has its own subpath.
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
export { provenanceOf, type Provenance } from "./provenance";
export {
  pickLeadImage,
  extractOgImage,
  fetchOgImage,
  searchGoogleImages,
  type LeadImage,
  type ImageSearchConfig,
} from "./lead-image";
export {
  keepImage,
  isBrandedImageHost,
  downloadImage,
  downloadLeadImage,
  imageDims,
  imageFilename,
  meetsLeadFloor,
  normalizeImageUrl,
  DeadImageError,
  MIN_LEAD_PX,
  type ImageDims,
  type DownloadedImage,
} from "./image";
export {
  harvestPages,
  pickGallery,
  collectSourcePages,
  extractImages,
  dedupeKey,
  type GalleryPhoto,
  type HarvestResult,
  type HarvestArgs,
  type PageImages,
  type CollectPagesArgs,
} from "./gallery";
