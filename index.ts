/**
 * ai-journalist — the PUBLIC entry: `runPipeline(input: RunInput) → GeneratedPost`.
 *
 * This is the engine's whole usable surface for an adopter. Given the four ports
 * (Source / Sink / Linker / EngineConfig — see ./ports), it runs BOTH phases
 * end-to-end:
 *
 *   1. DISCOVER — pull the Source's signal and pick + plan the story. A fixed
 *      `input.topic` plans THAT story (operator path, no anti-repetition); an
 *      omitted topic discovers a fresh, uncovered one from the signal.
 *   2. GENERATE — run the section-research → gate-chain orchestration
 *      (`runGeneration`) to a publish-ready article.
 *   3. PUBLISH — hand the finished post to the Sink (unless `dryRun`), then
 *      return the `GeneratedPost` either way (so a dry run yields it for review).
 *
 * "Plug any data in", made usable: an adopter brings the four ports, calls this,
 * and gets a finished post — no engine code.
 *
 * Engine-pure: imports ONLY sibling engine modules — NOTHING from a host app,
 * ORM, or framework. The couplings a full host's `runGeneration` needs but the
 * four ports can't express (the DATA gathers, the content-rewriting link
 * functions, the named knobs, the per-run telemetry) ride in through
 * `input.internals` (an OPTIONAL, engine-pure carrier the adapter populates —
 * see `EngineInternals` in ./ports). The entry maps the public ports it CAN onto
 * the engine deps (`config.llm` → the discovery `llm`, `source.gatherSignal` /
 * `coveredTopics`, `sink.publish`) and reads the rest from the carrier — that
 * port→deps wiring IS the adapter↔engine boundary made explicit.
 *
 * Behavior-preserving: the discovery → generation → publish CALL ORDER and the
 * inputs to each are byte-for-byte what the old `main()` ran inline; only the
 * couplings became injected. The golden guard replays the whole thing through
 * `runBlogAuto` → `main` → here.
 */
import { discoverStory, planForTopic } from "./discovery";
import { buildDigest } from "./digest";
import { type Plan } from "./planning";
import { type GeneratedPost, type RunInput } from "./ports";

// Re-exported module surface (also importable via the "./digest" subpath).
export { buildDigest, type DigestDeps } from "./digest";

/**
 * Run the full pipeline: discover (or plan the fixed topic) → generate → publish.
 *
 * @throws if `input.internals` is absent — the four public ports alone cannot
 * supply the deps `runGeneration` consumes; a host adapter must build and pass
 * `EngineInternals` (see `examples/basic.ts` for a minimal offline one). Failing
 * loud here beats a half-built deps object surfacing a cryptic later error.
 */
export async function runPipeline(input: RunInput): Promise<GeneratedPost> {
  const internals = input.internals;
  if (internals === undefined) {
    throw new Error(
      "runPipeline: input.internals is required — the four public ports " +
        "(Source/Sink/Linker/EngineConfig) cannot supply the engine's full " +
        "dependency set (the proprietary DATA gathers, link tail, named knobs, " +
        "and per-run telemetry). The adapter must build and pass EngineInternals.",
    );
  }
  const { discoveryDeps, generate, slugify, finalizePost } = internals;

  // Part C: capture the pooled discovery corpus for the GENERAL research
  // digest — only when the host turned digests on by supplying `digestSection`.
  // The discovery deps are wrapped (spread copy — no mutation, no cross-run
  // chain growth) with a capturing `onCorpus` that chains any host-registered
  // observer. Without `digestSection` the deps pass through untouched and the
  // whole run is byte-identical to the pre-digest engine.
  let discoveryCorpus = "";
  const discoDeps =
    discoveryDeps.digestSection !== undefined
      ? {
          ...discoveryDeps,
          onCorpus: (pool: string): void => {
            discoveryCorpus = pool;
            discoveryDeps.onCorpus?.(pool);
          },
        }
      : discoveryDeps;

  // Phase 1 — discover + plan. A fixed topic plans THAT story (seeded, no
  // anti-repetition); otherwise discover a fresh, uncovered one from the signal.
  // `discoveryDeps.gatherSignal` IS `input.source.gatherSignal()` (the adapter
  // binds the Source into the deps bundle), so the Source owns the data and the
  // engine owns the discovery logic — exactly the port contract.
  const plan: Plan = input.topic
    ? await planForTopic(input.topic, discoDeps)
    : await discoverStory(discoDeps);

  // Stable, title-derived publish slug (must match across create→polish runs).
  const slug = slugify(plan.title);

  // Part C: the GENERAL research digest — ONE extractive six-box digest of the
  // whole discovery corpus, built AFTER planning and BEFORE the section writes,
  // threaded into every section prompt as background context via
  // `SectionWriterDeps.generalDigest`. Set on the SHARED deps bundle (the
  // adapter binds this same object into `PipelineDeps.blogDeps` — see
  // `EngineInternals.discoveryDeps`), the same in-place threading the theme
  // uses for gateDeps. Always reassigned when digests are on — undefined when
  // nothing was captured (e.g. the --topic path, which skips `discoverStory`)
  // — so a prior run's digest can never leak through a reused bundle.
  if (discoveryDeps.digestSection !== undefined) {
    discoveryDeps.generalDigest = discoveryCorpus.trim()
      ? await buildDigest(discoveryCorpus, "general", {
          llm: discoveryDeps.llm,
          model: discoveryDeps.model,
          withRetry: discoveryDeps.withRetry,
        })
      : undefined;
  }

  // Phase 2 — the section-research → gate-chain orchestration → article
  // (`generate` is the adapter-bound `runGeneration(plan, pipelineDeps)`).
  const article = await generate(plan);

  // The OUTPUT post envelope (byline + the run's gate telemetry snapshot).
  // `plan.title` is the DISCOVERY topic (the post's targetKeyword) — distinct
  // from `article.title`, the final headline the gate chain produced.
  const post = finalizePost(article, slug, plan.title);

  // Phase 3 — publish, unless this is a dry run. Either way return the post so a
  // dry run yields it for inspection (golden-guard / preview).
  if (!input.dryRun) {
    await input.sink.publish(post);
  }
  return post;
}
