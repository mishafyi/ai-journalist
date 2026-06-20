/**
 * composeSources — fan several `Source`s into one.
 *
 *   gatherSignal   · runs every source, CONCATENATES their `items` (in order)
 *                    and joins their `corpus` blocks. `framing` is taken from
 *                    the first source that supplies one.
 *   gatherFacts    · FIRST-WINS — delegates to the first source that implements
 *                    `gatherFacts`. Only exposed if some source has it.
 *   coveredTopics  · FIRST-WINS — same rule. Only exposed if some source has it.
 *
 * First-wins (not merge) for facts/covered keeps grounding + anti-repetition
 * authoritative to a single owner; the signal is the one thing it makes sense
 * to pool across sources.
 *
 * Imports only `./ports` — nothing from a host app, no SDKs.
 */
import type {
  CoveredTopic,
  DiscoverySignal,
  GroundingFacts,
  SignalItem,
  Source,
  TopicBrief,
} from "../ports";

export function composeSources(sources: Source[]): Source {
  const factsSource = sources.find((s) => s.gatherFacts);
  const coveredSource = sources.find((s) => s.coveredTopics);

  const composed: Source = {
    async gatherSignal(): Promise<DiscoverySignal> {
      const signals = await Promise.all(sources.map((s) => s.gatherSignal()));
      const items: SignalItem[] = signals.flatMap((sig) => sig.items);
      const corpora = signals
        .map((sig) => sig.corpus)
        .filter((c): c is string => Boolean(c));
      const framing = signals.find((sig) => sig.framing !== undefined)?.framing;
      return {
        items,
        ...(framing !== undefined ? { framing } : {}),
        ...(corpora.length ? { corpus: corpora.join("\n\n") } : {}),
      };
    },
  };

  if (factsSource) {
    composed.gatherFacts = (topic: TopicBrief): Promise<GroundingFacts> =>
      factsSource.gatherFacts!(topic);
  }

  if (coveredSource) {
    composed.coveredTopics = (): Promise<CoveredTopic[]> =>
      coveredSource.coveredTopics!();
  }

  return composed;
}
