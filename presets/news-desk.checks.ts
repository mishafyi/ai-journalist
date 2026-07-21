import { PERSONAS, buildRetellPlan, composeAnalysis } from "./news-desk";
import { DISANALOGY_MARKER, NO_PARALLEL_PHRASE } from "../gates";
import type { LlmClient } from "../ports";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  ok("three neutral personas ship",
    PERSONAS.historian.name.length > 0 && PERSONAS.realist.method.length > 0 && PERSONAS.systems.voice.length > 0,
    JSON.stringify(Object.keys(PERSONAS)));

  const plan = buildRetellPlan("Tariff bill passes Senate");
  ok("fixed template: exactly the three spec'd sections, no LLM",
    plan.sections.length === 3 &&
      plan.sections[0].heading === "What happened" &&
      plan.sections[1].heading === "The numbers and reactions" &&
      plan.sections[2].heading === "Context" &&
      plan.title === "Tariff bill passes Senate",
    JSON.stringify(plan.sections.map((s) => s.heading)));
  ok("sections carry empty queries (research is the shared evidence corpus)",
    plan.sections.every((s) => s.queries.length === 0), "queries");

  // composeAnalysis: first draft violates the contract, second complies —
  // the retry must feed the failures back into the prompt.
  const GOOD = `## Analysis — ${PERSONAS.historian.name}\n\nBBC documents the fee spike; CNN confirms the reroute. Suez Crisis dynamics apply.\n\n${DISANALOGY_MARKER} Unlike 1956 there is no canal seizure — the modern lever is insurance pricing, which reverses faster than occupations do.`;
  let call = 0;
  const seenPrompts: string[] = [];
  const llm = {
    async complete(args: { system?: string; prompt: string }): Promise<string> {
      call += 1;
      seenPrompts.push(args.prompt);
      return call === 1 ? "## My hot take\n\nNo citations here." : GOOD;
    },
    async completeStructured(): Promise<never> { throw new Error("unused"); },
  } as unknown as LlmClient;

  const analysis = await composeAnalysis({
    llm, persona: PERSONAS.historian, evidenceBlock: "SOURCE BBC …\nSOURCE CNN …",
    outletNames: ["BBC", "CNN"],
    parallel: { era: "1956", event: "Suez Crisis", actors: ["Egypt"], claimedSimilarity: "chokepoint",
      wikipediaTitle: "Suez Crisis", wikipediaUrl: "https://en.wikipedia.org/wiki/Suez_Crisis",
      extract: "The 1956 crisis…", score: 0.8 },
    maxAttempts: 3,
  });
  ok("composeAnalysis: retries until the contract passes", call === 2 && analysis === GOOD, `calls=${call}`);
  ok("retry prompt carries the contract failures back to the model",
    seenPrompts[1].includes("previous attempt failed") && seenPrompts[1].includes("≥2"), seenPrompts[1].slice(0, 200));

  // Honest no-parallel path: the prompt must DEMAND the verbatim phrase.
  let sawPhrase = false;
  const llm2 = {
    async complete(args: { prompt: string }): Promise<string> {
      sawPhrase = args.prompt.includes(NO_PARALLEL_PHRASE);
      return `## Analysis — ${PERSONAS.historian.name}\n\nBBC and CNN agree on the repricing. ${NO_PARALLEL_PHRASE} The evidence alone says: premiums are the new blockade.`;
    },
    async completeStructured(): Promise<never> { throw new Error("unused"); },
  } as unknown as LlmClient;
  await composeAnalysis({ llm: llm2, persona: PERSONAS.historian, evidenceBlock: "…",
    outletNames: ["BBC", "CNN"], parallel: null, maxAttempts: 1 });
  ok("no-parallel prompt demands the honest phrase verbatim", sawPhrase, "phrase in prompt");

  // Directed guard: an empty-string parallel event must take the null (honest
  // absence) path — includes("") is vacuously true, so "" would neuter the
  // contract's name check while its prompt demanded a marker for a nameless event.
  let sawPhraseEmpty = false;
  const llm3 = {
    async complete(args: { prompt: string }): Promise<string> {
      sawPhraseEmpty = args.prompt.includes(NO_PARALLEL_PHRASE);
      return `## Analysis — ${PERSONAS.historian.name}\n\nBBC and CNN agree on the repricing. ${NO_PARALLEL_PHRASE} The evidence alone says: premiums are the new blockade.`;
    },
    async completeStructured(): Promise<never> { throw new Error("unused"); },
  } as unknown as LlmClient;
  await composeAnalysis({ llm: llm3, persona: PERSONAS.historian, evidenceBlock: "…",
    outletNames: ["BBC", "CNN"],
    parallel: { era: "1956", event: "", actors: ["Egypt"], claimedSimilarity: "chokepoint",
      wikipediaTitle: "", wikipediaUrl: "", extract: "", score: 0 },
    maxAttempts: 1 });
  ok("empty parallelEvent treated as honest absence (null path)", sawPhraseEmpty, "empty-event guard");

  // Exhausted attempts throw with the failures.
  const llmBad = {
    async complete(): Promise<string> { return "nope"; },
    async completeStructured(): Promise<never> { throw new Error("unused"); },
  } as unknown as LlmClient;
  let threw = false;
  try {
    await composeAnalysis({ llm: llmBad, persona: PERSONAS.historian, evidenceBlock: "…",
      outletNames: ["BBC", "CNN"], parallel: null, maxAttempts: 2 });
  } catch (err: unknown) {
    threw = String(err).includes("analysis failed the contract");
  }
  ok("exhausted attempts throw with contract context", threw, "throw path");

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("news-desk (part 1) checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`news-desk.checks failed: ${String(err)}\n`);
  process.exit(1);
});
