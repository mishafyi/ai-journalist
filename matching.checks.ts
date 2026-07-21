import { createHeadlineMatcher } from "./matching";
import type { Embedder } from "./ports";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  // Trigram fallback (no embedder): near-identical headline matches, unrelated doesn't.
  const tri = createHeadlineMatcher({});
  const hit = await tri.match(
    "Senate passes sweeping tariff bill after marathon session",
    ["Senate passes tariff bill after marathon session", "Local team wins championship"],
    0.35,
  );
  ok("trigram: matching headline wins", hit !== null && hit.index === 0, JSON.stringify(hit));
  ok("trigram: unrelated stays below threshold",
    (await tri.match("Senate passes tariff bill", ["Recipe: perfect sourdough"], 0.35)) === null,
    "expected null");

  // Embedder path: orthogonal fake vectors → exact control of scores, ONE call.
  let embedCalls = 0;
  const fake: Embedder = {
    async embed(texts: string[]): Promise<number[][]> {
      embedCalls += 1;
      // probes and MATCH-prefixed candidates align on [1,0]; everything else
      // is orthogonal [0,1] — exact score control for both match and matchAny.
      return texts.map((t) => (t.startsWith("probe") || t.startsWith("MATCH") ? [1, 0] : [0, 1]));
    },
  };
  const emb = createHeadlineMatcher({ embedder: fake });
  const h2 = await emb.match("probe", ["MATCH close headline", "far headline"], 0.62);
  ok("embedder: cosine picks the aligned vector", h2 !== null && h2.index === 0 && h2.score > 0.99, JSON.stringify(h2));
  ok("embedder: one embed call per match", embedCalls === 1, String(embedCalls));

  embedCalls = 0;
  const hits = await emb.matchAny(["probe one", "probe two"], ["MATCH a", "far b", "MATCH c"], 0.62);
  ok("matchAny: returns every candidate ≥ threshold with max-across-probes score",
    hits.length === 2 && hits[0].index === 0 && hits[1].index === 2, JSON.stringify(hits));
  ok("matchAny: ONE embed call total", embedCalls === 1, String(embedCalls));
  ok("empty candidates → null / []",
    (await emb.match("p", [], 0.5)) === null && (await emb.matchAny(["p"], [], 0.5)).length === 0,
    "empties");

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("matching checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`matching.checks failed: ${String(err)}\n`);
  process.exit(1);
});
