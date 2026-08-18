/**
 * writeArticle — the one-call entry for "I have some data, give me an article".
 *
 * `runPipeline` is the full contract: four ports plus the `EngineInternals`
 * carrier, assembled by the caller. That is the right shape for a host adapter
 * wiring its own gate chain, and the wrong shape for someone deciding whether
 * this engine is worth adopting — it asks for five imports and twenty lines
 * before the first article exists.
 *
 * This wraps it. Bring your data, a model, a search backend and a name to
 * publish under; the default preset assembles the rest. The article comes back
 * as markdown rather than being published, so there is nothing to configure
 * before you can read the output.
 *
 * `from` accepts data where it already lives:
 *
 *   - an ARRAY of `SignalItem`  → used directly
 *   - a `DiscoverySignal`       → used directly
 *   - a path to a .json file    → read from disk (`createFileSource`)
 *   - an http(s) URL            → fetched; feed-shaped URLs parse as RSS
 *   - your own `Source`         → passed straight through
 *
 * Engine-pure: no `process.env` reads (the AST guard forbids them outside
 * `clients/**`), no filesystem writes, no SDK imports. Pass a model and a
 * search client — `clients/auto.ts` builds those from the environment for
 * callers who want that convenience.
 */
import { runPipeline } from "./index";
import { createDefaultInternals } from "./presets/default";
import type { DefaultInternalsOptions } from "./presets/default";
import { createFileSource } from "./sources/file";
import { createHttpSource } from "./sources/http";
import { createRssSource } from "./sources/rss";
import type {
  BrandProfile,
  DiscoverySignal,
  GeneratedPost,
  LlmClient,
  SearchClient,
  SignalItem,
  Sink,
  Source,
} from "./ports";

/** What `writeArticle` accepts as "your data". */
export type ArticleInput = SignalItem[] | DiscoverySignal | string | Source;

export interface WriteArticleOptions {
  /** Your data: items, a signal, a file path, an http(s) URL, or a Source. */
  from: ArticleInput;
  /**
   * Who is publishing. Only `name` and `beat` are required — `publication` and
   * `bylines` are derived when omitted, so the smallest useful call is
   * `{ name: "My Outlet", beat: "climate tech" }`.
   */
  brand: Pick<BrandProfile, "name" | "beat"> & Partial<BrandProfile>;
  /** The model. See `clients/openrouter-llm`, `clients/gemini-llm`, `clients/ollama-llm`. */
  llm: LlmClient;
  /** Web search. See `clients/firecrawl-search`, `clients/searxng-search`. */
  search: SearchClient;
  /** Write this story instead of discovering one from the signal. */
  topic?: string;
  /** Pinned model id; omit → the client's own default (dynamic, for OpenRouter). */
  model?: string;
  /** Progress events — the CLI renders these as steps. */
  onEvent?: DefaultInternalsOptions["onEvent"];
}

export interface WrittenArticle {
  /** The article body, ready to write to a file or hand to a CMS. */
  markdown: string;
  title: string;
  slug: string;
  /** The full engine result, for anything the three fields above omit. */
  post: GeneratedPost;
}

/** `true` for an http(s) URL — anything else is treated as a filesystem path. */
function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** `true` for URLs that look like a feed rather than a JSON endpoint. */
export function looksLikeFeed(url: string): boolean {
  return (
    /\.(xml|rss|atom)(\?|$)/i.test(url) || /\/(rss|feed|atom)(\/|\?|$)/i.test(url)
  );
}

/** `true` when the value already satisfies `Source` (has the one required method). */
function isSource(value: unknown): value is Source {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Source).gatherSignal === "function"
  );
}

/** Wrap an in-memory signal as a `Source`. */
function inlineSource(signal: DiscoverySignal): Source {
  return { gatherSignal: async (): Promise<DiscoverySignal> => signal };
}

/**
 * Resolve whatever the caller passed into a `Source`.
 *
 * Every branch fails loud naming what arrived, rather than falling back to an
 * empty signal — an article written from no data is the failure mode this
 * engine exists to prevent.
 */
export function resolveSource(from: ArticleInput): Source {
  if (isSource(from)) return from;

  if (Array.isArray(from)) {
    if (from.length === 0) {
      throw new Error(
        "writeArticle: `from` is an empty array — there is no signal to write about.",
      );
    }
    return inlineSource({ items: from });
  }

  if (typeof from === "string") {
    if (isUrl(from)) {
      return looksLikeFeed(from)
        ? createRssSource({ feeds: [from] })
        : createHttpSource({ signalUrl: from });
    }
    return createFileSource({ signalPath: from });
  }

  if (typeof from === "object" && from !== null) {
    const signal = from;
    if (!Array.isArray(signal.items) || signal.items.length === 0) {
      throw new Error(
        "writeArticle: `from.items` is empty — there is no signal to write about.",
      );
    }
    return inlineSource(signal);
  }

  throw new Error(
    `writeArticle: \`from\` must be items, a signal, a file path, a URL or a Source — received ${typeof from}.`,
  );
}

/** Fill in the `BrandProfile` fields most callers do not care to write out. */
export function completeBrand(brand: WriteArticleOptions["brand"]): BrandProfile {
  return {
    ...brand,
    name: brand.name,
    beat: brand.beat,
    publication: brand.publication ?? brand.name,
    bylines: brand.bylines ?? [`${brand.name} Staff`],
  };
}

/**
 * Write one article from your data and return it as markdown.
 *
 * Runs with `dryRun`, so nothing is published and the sink is never called:
 * persisting the result is the caller's decision. Pass a real `Sink` to
 * `runPipeline` directly when you want the engine to publish for you.
 */
export async function writeArticle(
  options: WriteArticleOptions,
): Promise<WrittenArticle> {
  const { from, llm, search, topic, model, onEvent } = options;
  const brand = completeBrand(options.brand);
  const source = resolveSource(from);

  // `RunInput.sink` is required by the type but unreachable under dryRun; this
  // one throws rather than pretending a publish happened, so a future change
  // that drops dryRun fails loudly instead of silently discarding articles.
  const unusedSink: Sink = {
    publish: async () => {
      throw new Error(
        "writeArticle: the sink was called during a dry run — this is a bug in ai-journalist.",
      );
    },
  };

  const post = await runPipeline({
    source,
    sink: unusedSink,
    dryRun: true,
    topic,
    config: { llm, search, brand },
    internals: createDefaultInternals({ llm, search, brand, source, model, onEvent }),
  });

  return {
    markdown: post.markdown,
    title: post.title,
    slug: post.slug,
    post,
  };
}
