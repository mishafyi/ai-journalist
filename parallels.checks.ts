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
        args.messages.some((m) => m.content.includes("STORY:") && m.content.includes("COUNT: 2")),
        args.messages.map((m) => m.content.slice(0, 60)).join("|"));
      return { candidates: [
        { era: "1956", event: "Suez Crisis", actors: ["Egypt", "Britain", "France"], claimedSimilarity: "canal chokepoint crisis reshaping trade routes" },
        { era: "1973", event: "OPEC oil embargo", actors: ["OPEC", "United States"], claimedSimilarity: "energy supply weaponized against the West" },
      ] } as T;
    },
  } as unknown as LlmClient;
  const cands = await proposeParallels({ llm: fakeLlm, storySummary: "Strait blockade raises shipping costs", count: 2 });
  ok("propose: returns the schema'd candidates", cands.length === 2 && cands[0].event === "Suez Crisis", JSON.stringify(cands[0]));

  // An empty string in the model's JSON drops that string or candidate, never the run.
  // The stub validates like clients/gemini-llm.ts does (schema.parse on the reply);
  // 17 runs between 2026-09-10 and 09-24 died on exactly these replies.
  const parsingLlm = {
    async complete(): Promise<string> { throw new Error("unused"); },
    async completeStructured<T>(args: { schema: { parse(v: unknown): T } }): Promise<T> {
      return args.schema.parse({ candidates: [
        { era: "1956", event: "Suez Crisis", actors: ["Egypt", "", "France"], claimedSimilarity: "canal chokepoint crisis reshaping trade routes" },
        { era: "", event: "", actors: [""], claimedSimilarity: "" },
        { era: "1973", event: "OPEC oil embargo", actors: [], claimedSimilarity: "energy supply weaponized against the West" },
        { era: "", event: "Bretton Woods conference", actors: ["IMF"], claimedSimilarity: "a monetary order rewritten by the victors" },
      ] });
    },
  } as unknown as LlmClient;
  let emptied: Awaited<ReturnType<typeof proposeParallels>> = [];
  let threw = "";
  try {
    emptied = await proposeParallels({ llm: parsingLlm, storySummary: "Strait blockade raises shipping costs", count: 4 });
  } catch (err: unknown) {
    threw = String(err).slice(0, 160);
  }
  ok("propose: empty strings in the reply do not throw", threw === "", threw);
  ok("propose: a candidate with no event or no era is dropped, the others kept",
    emptied.map((c) => c.event).join("|") === "Suez Crisis|OPEC oil embargo", JSON.stringify(emptied.map((c) => c.event)));
  ok("propose: an empty actor is dropped from its candidate",
    JSON.stringify(emptied[0]?.actors) === '["Egypt","France"]', JSON.stringify(emptied[0]?.actors));

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
  // Fulltext fallback (2026-07-26): opensearch is a prefix matcher and dropped
  // wordy-but-real candidates in production ("Rwandan Genocide and Aftermath").
  const fallbackFetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("action=opensearch")) return new Response(JSON.stringify(["q", [], [], []]), { status: 200 });
    if (u.includes("list=search"))
      return new Response(JSON.stringify({ query: { search: [{ title: "Suez Crisis" }] } }), { status: 200 });
    return new Response(JSON.stringify({ title: "Suez Crisis", extract: "The Suez Crisis of 1956 saw Egypt, Britain and France clash over the canal.",
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Suez_Crisis" } } }), { status: 200 });
  }) as typeof fetch;
  const viaFulltext = await verifyParallel({ candidate: cands[0], fetchImpl: fallbackFetch });
  ok("verify: opensearch miss + fulltext hit → resolves to the canonical page",
    viaFulltext !== null && viaFulltext.wikipediaTitle === "Suez Crisis" && viaFulltext.score > 0.5,
    JSON.stringify(viaFulltext));

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
