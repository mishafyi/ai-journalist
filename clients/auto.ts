/**
 * clients/auto.ts — pick a model and a search backend from the environment.
 *
 * The engine core is env-free by construction (an AST guard fails CI on any
 * `process.env` read outside `clients/**`), which is right for a library and
 * unhelpful for a first run: somebody evaluating this should not have to learn
 * which client constructor matches which key before they see an article.
 *
 * So the env-reading lives here, in the one directory allowed to do it, and it
 * is explicit rather than magic — each resolver reports which provider it chose
 * and how, and refuses to guess when nothing is configured.
 *
 * There are two working setups, and the free one is deliberately as visible as
 * the paid one:
 *
 *   PAID   OPENROUTER_API_KEY + FIRECRAWL_API_KEY
 *   FREE   OLLAMA_BASE_URL (a local model) + SEARXNG_URL (a self-hosted index)
 *
 * A Google AI client exists on a feature branch; add it here when it lands on
 * main rather than importing a module this branch does not ship.
 *
 * Nothing here is required to use the engine — `writeArticle({ llm, search })`
 * takes the clients directly. This is the convenience layer for CLIs and demos.
 */
import { createOpenRouterLlm } from "./openrouter-llm";
import { createOllamaLlm } from "./ollama-llm";
import { createFirecrawlSearch } from "./firecrawl-search";
import { createSearxngSearch } from "./searxng-search";
import type { LlmClient, SearchClient } from "../ports";

/** Which provider a resolver chose, so a CLI can show it rather than guess. */
export interface Resolved<T> {
  client: T;
  provider: string;
  /** How it was configured, e.g. "OPENROUTER_API_KEY". */
  via: string;
}

export type LlmProvider = "openrouter" | "ollama";
export type SearchProvider = "firecrawl" | "searxng";

/** Model providers buildable from this environment, in preference order. */
export function availableLlmProviders(
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider[] {
  const out: LlmProvider[] = [];
  if (env.OPENROUTER_API_KEY) out.push("openrouter");
  if (env.OLLAMA_BASE_URL) out.push("ollama");
  return out;
}

/** Search backends buildable from this environment, in preference order. */
export function availableSearchProviders(
  env: NodeJS.ProcessEnv = process.env,
): SearchProvider[] {
  const out: SearchProvider[] = [];
  if (env.FIRECRAWL_API_KEY || env.FIRECRAWL_API_URL) out.push("firecrawl");
  if (env.SEARXNG_URL) out.push("searxng");
  return out;
}

/** Shown when nothing is configured — names the free route, not just the paid one. */
export const LLM_SETUP_HELP = [
  "No model configured. Set one of:",
  "  OPENROUTER_API_KEY=sk-or-…              hundreds of models, paid",
  "  OLLAMA_BASE_URL=http://localhost:11434  free, runs on your machine",
].join("\n");

export const SEARCH_SETUP_HELP = [
  "No web search configured. Set one of:",
  "  FIRECRAWL_API_KEY=fc-…                   Firecrawl cloud, paid",
  "  FIRECRAWL_API_URL=http://localhost:3002  self-hosted Firecrawl",
  "  SEARXNG_URL=http://localhost:8888        free, self-hosted metasearch",
].join("\n");

/**
 * Build an `LlmClient` from the environment.
 *
 * `prefer` forces a provider (a CLI passes the user's choice); otherwise the
 * first configured one wins.
 *
 * @throws naming every accepted variable when nothing is configured — a missing
 * key should read as a setup step, not as a stack trace.
 */
export function llmFromEnv(
  prefer?: LlmProvider,
  env: NodeJS.ProcessEnv = process.env,
): Resolved<LlmClient> {
  const available = availableLlmProviders(env);
  const choice = prefer ?? available[0];

  if (!choice) throw new Error(LLM_SETUP_HELP);
  if (prefer && !available.includes(prefer)) {
    throw new Error(
      `Model provider "${prefer}" was requested but is not configured.\n\n${LLM_SETUP_HELP}`,
    );
  }

  if (choice === "openrouter") {
    return {
      client: createOpenRouterLlm({}),
      provider: "openrouter",
      via: "OPENROUTER_API_KEY",
    };
  }
  return {
    client: createOllamaLlm({
      baseUrl: env.OLLAMA_BASE_URL ?? "",
      model: env.OLLAMA_MODEL ?? "llama3.1",
    }),
    provider: "ollama",
    via: "OLLAMA_BASE_URL",
  };
}

/**
 * Build a `SearchClient` from the environment.
 *
 * @throws naming every accepted variable when nothing is configured.
 */
export function searchFromEnv(
  prefer?: SearchProvider,
  env: NodeJS.ProcessEnv = process.env,
): Resolved<SearchClient> {
  const available = availableSearchProviders(env);
  const choice = prefer ?? available[0];

  if (!choice) throw new Error(SEARCH_SETUP_HELP);
  if (prefer && !available.includes(prefer)) {
    throw new Error(
      `Search provider "${prefer}" was requested but is not configured.\n\n${SEARCH_SETUP_HELP}`,
    );
  }

  if (choice === "firecrawl") {
    return {
      client: createFirecrawlSearch({ apiUrl: env.FIRECRAWL_API_URL }),
      provider: "firecrawl",
      via: env.FIRECRAWL_API_URL ? "FIRECRAWL_API_URL" : "FIRECRAWL_API_KEY",
    };
  }
  return {
    client: createSearxngSearch({ baseUrl: env.SEARXNG_URL }),
    provider: "searxng",
    via: "SEARXNG_URL",
  };
}
