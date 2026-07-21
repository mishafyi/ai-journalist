import { proposeParallels, verifyParallel, selectParallel } from "./parallels";
import type { LlmClient } from "./ports";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  // propose: schema-constrained via completeStructured; count honored in prompt.
  const fakeLlm = {
    async complete(): Promise<string> { throw new Error("unused"); },
    async completeStructured<T>(args: { messages: { content: string }[] }): Promise<T> {
      ok("propose: prompt carries the story summary and count",
        args.messages.some((m) => m.content.includes("STORY:") && m.content.includes("exactly 2")),
        args.messages.map((m) => m.content.slice(0, 60)).join("|"));
      return { candidates: [
        { era: "1956", event: "Suez Crisis", actors: ["Egypt", "Britain", "France"], claimedSimilarity: "canal chokepoint crisis reshaping trade routes" },
        { era: "1973", event: "OPEC oil embargo", actors: ["OPEC", "United States"], claimedSimilarity: "energy supply weaponized against the West" },
      ] } as T;
    },
  } as unknown as LlmClient;
  const cands = await proposeParallels({ llm: fakeLlm, storySummary: "Strait blockade raises shipping costs", count: 2 });
  ok("propose: returns the schema'd candidates", cands.length === 2 && cands[0].event === "Suez Crisis", JSON.stringify(cands[0]));

  // verify: opensearch → summary; token-overlap score.
  const fetchFor = (extract: string, found: boolean): typeof fetch =>
    (async (url: unknown) => {
      const u = String(url);
      if (u.includes("action=opensearch")) {
        return new Response(JSON.stringify(found ? ["q", ["Suez Crisis"], [""], ["https://en.wikipedia.org/wiki/Suez_Crisis"]] : ["q", [], [], []]), { status: 200 });
      }
      return new Response(JSON.stringify({ title: "Suez Crisis", extract,
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Suez_Crisis" } } }), { status: 200 });
    }) as typeof fetch;

  const good = await verifyParallel({
    candidate: cands[0],
    fetchImpl: fetchFor("The Suez Crisis of 1956 saw Egypt, Britain and France clash over the canal.", true),
  });
  ok("verify: overlap-scored hit carries extract + url",
    good !== null && good.score > 0.5 && good.wikipediaUrl.includes("Suez_Crisis"), JSON.stringify(good));
  ok("verify: opensearch miss → null",
    (await verifyParallel({ candidate: cands[0], fetchImpl: fetchFor("", false) })) === null, "expected null");
  const off = await verifyParallel({
    candidate: cands[0],
    fetchImpl: fetchFor("A completely unrelated topic about botany and gardening techniques.", true),
  });
  ok("verify: unrelated extract scores below the floor", off !== null && off.score < 0.3, JSON.stringify(off?.score));

  // select: picks highest ≥ minScore; none survive → null (honest path).
  const sel = await selectParallel({ candidates: cands, minScore: 0.3,
    fetchImpl: fetchFor("The Suez Crisis of 1956 saw Egypt, Britain and France clash over the canal.", true) });
  ok("select: best verified candidate wins", sel !== null && sel.event === "Suez Crisis", JSON.stringify(sel?.event));
  ok("select: none survive → null",
    (await selectParallel({ candidates: cands, minScore: 0.99, fetchImpl: fetchFor("botany", true) })) === null,
    "expected null");

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("parallels checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`parallels.checks failed: ${String(err)}\n`);
  process.exit(1);
});
