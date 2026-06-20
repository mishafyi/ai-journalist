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
import { type Plan } from "./planning";
import { type GeneratedPost, type RunInput } from "./ports";

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

  // Phase 1 — discover + plan. A fixed topic plans THAT story (seeded, no
  // anti-repetition); otherwise discover a fresh, uncovered one from the signal.
  // `discoveryDeps.gatherSignal` IS `input.source.gatherSignal()` (the adapter
  // binds the Source into the deps bundle), so the Source owns the data and the
  // engine owns the discovery logic — exactly the port contract.
  const plan: Plan = input.topic
    ? await planForTopic(input.topic, discoveryDeps)
    : await discoverStory(discoveryDeps);

  // Stable, title-derived publish slug (must match across create→polish runs).
  const slug = slugify(plan.title);

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
