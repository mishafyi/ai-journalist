/**
 * presets/news-desk.ts — the spec'd news-desk path. Part 1: neutral personas,
 * the FIXED retell template (the model fills sections, never designs them —
 * the gemma-narrowing rule extended to structure), and the contract-gated
 * Analysis composer. Part 2 (createNewsDesk) orchestrates.
 */
import { checkAnalysisContract, DISANALOGY_MARKER, NO_PARALLEL_PHRASE } from "../gates";
import type { VerifiedParallel } from "../parallels";
import type { Plan } from "../planning";
import type { LlmClient, PersonaProfile } from "../ports";

/** Three neutral example personas (spec) — method over ideology. */
export const PERSONAS: {
  historian: PersonaProfile;
  realist: PersonaProfile;
  systems: PersonaProfile;
} = {
  historian: {
    name: "The Historian",
    method:
      "Read today's event against the long record. Anchor every judgment in the verified historical parallel and in dated, sourced facts.",
    priors:
      "Structural forces outlast personalities; most 'unprecedented' events have precedents; institutions adapt slower than markets.",
    voice: "Measured, concrete, professorial without jargon. Short sentences when the point lands.",
  },
  realist: {
    name: "The Realist",
    method:
      "Follow incentives and power. Ask who gains, who pays, and what each actor's cheapest next move is — grounded only in the sourced evidence.",
    priors:
      "Stated reasons are rarely operative reasons; capability beats intention; costs are borne by whoever can least avoid them.",
    voice: "Direct, unsentimental, occasionally dry. Never cynical for its own sake.",
  },
  systems: {
    name: "The Systems Thinker",
    method:
      "Trace feedback loops, bottlenecks, and second-order effects visible in the evidence. Name what dampens or amplifies the shock.",
    priors:
      "Tightly coupled systems fail fast; buffers are invisible until they empty; incentives create the topology.",
    voice: "Analytical, diagram-in-prose, plain words for complex mechanisms.",
  },
};

/** The FIXED three-section retell (spec: What happened / The numbers &
 *  reactions / Context). queries stay empty — every section grounds in the
 *  ONE shared evidence corpus the orchestrator supplies via gatherResearch. */
export function buildRetellPlan(storyHeadline: string): Plan {
  return {
    title: storyHeadline,
    angle: "what happened, what the numbers say, and the context a reader needs",
    themeStatement: `${storyHeadline} — the essence of today's coverage, retold with per-outlet attribution`,
    sections: [
      {
        heading: "What happened",
        intent:
          "The event itself: who did what, when, where — attributed per outlet ('X reports…, per Y…'), leading with the newest confirmed developments.",
        queries: [],
      },
      {
        heading: "The numbers and reactions",
        intent:
          "Every concrete figure, quote, and official reaction in the evidence, verbatim where quoted, each attributed to its outlet.",
        queries: [],
      },
      {
        heading: "Context",
        intent:
          "Only the background the evidence itself supplies: what preceded this, what it connects to, what remains unresolved.",
        queries: [],
      },
    ],
  };
}

/** Compose the persona Analysis; accept only what checkAnalysisContract
 *  passes. Failures feed back into the retry prompt; exhausted attempts throw. */
export async function composeAnalysis(args: {
  llm: LlmClient;
  persona: PersonaProfile;
  evidenceBlock: string;
  outletNames: readonly string[];
  parallel: VerifiedParallel | null;
  maxAttempts: number;
  model?: string;
  log?: (line: string) => void;
}): Promise<string> {
  const { persona } = args;
  // Guard: an empty-string event is honest absence, not a parallel — the
  // contract's includes("") is vacuously true, so "" must take the null path.
  const parallel = args.parallel !== null && args.parallel.event.trim() !== "" ? args.parallel : null;
  const parallelBlock =
    parallel === null
      ? `NO parallel survived verification. You MUST include this sentence verbatim: "${NO_PARALLEL_PHRASE}" — then analyze on the evidence alone.`
      : `VERIFIED HISTORICAL PARALLEL (from Wikipedia — cite it by name: "${parallel.event}"):\n${parallel.extract}\nClaimed similarity: ${parallel.claimedSimilarity}\nYou MUST include a paragraph starting exactly with "${DISANALOGY_MARKER}" stating where the parallel does NOT hold.`;

  const system = `You write the Analysis column for a news desk, as the persona below. Ground EVERY claim in the supplied evidence — cite at least two outlets by name. Never invent facts, quotes, or history.\n\nPERSONA: ${persona.name}\nMethod: ${persona.method}\nPriors: ${persona.priors}\nVoice: ${persona.voice}`;

  const base = `EVIDENCE (per-outlet, the only facts you may use):\n${args.evidenceBlock}\n\n${parallelBlock}\n\nWrite the Analysis section now. Requirements:\n- Open with exactly: ## Analysis — ${persona.name}\n- Cite at least two of these outlets by name: ${args.outletNames.join(", ")}\n- 200-400 words, in the persona's voice.`;

  let lastFailures: string[] = [];
  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? base
        : `${base}\n\nYour previous attempt failed the contract:\n${lastFailures.map((f) => `- ${f}`).join("\n")}\nFix every failure and rewrite the full section.`;
    const analysis = await args.llm.complete({
      system,
      prompt,
      temperature: 0.4,
      ...(args.model === undefined ? {} : { model: args.model }),
    });
    const verdict = checkAnalysisContract(analysis, {
      personaName: persona.name,
      outletNames: args.outletNames,
      parallelEvent: parallel === null ? null : parallel.event,
    });
    if (verdict.ok) return analysis;
    lastFailures = verdict.failures;
    args.log?.(`analysis attempt ${attempt}/${args.maxAttempts} failed contract: ${verdict.failures.join(" | ")}`);
  }
  throw new Error(`analysis failed the contract after ${args.maxAttempts} attempts: ${lastFailures.join(" | ")}`);
}
