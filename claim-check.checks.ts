import { CORROBORATION_OVERLAP, checkClaims, termOverlap } from "./claim-check";
import type { LlmClient, SearchClient } from "./ports";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (n: string, c: boolean, d: string): void => {
    if (c) process.stdout.write(`PASS ${n}\n`);
    else { failures += 1; process.stdout.write(`FAIL ${n} — ${d}\n`); }
  };

  const CLAIM = "The central bank raised interest rates by fifty basis points to a twenty-year high";
  ok("a result restating the claim scores above the bar",
    termOverlap(CLAIM, "Central bank raises interest rates fifty basis points to twenty-year high") >= CORROBORATION_OVERLAP, "");
  ok("an unrelated result scores below it",
    termOverlap(CLAIM, "Local team wins championship after dramatic penalty shootout") < CORROBORATION_OVERLAP, "");
  ok("an empty claim never divides by zero", termOverlap("", "anything") === 0, "");

  const llm = {
    async complete() { return ""; },
    async completeStructured() { return { claims: [CLAIM, "The bank chair said the policy would hold through winter"] }; },
  } as unknown as LlmClient;

  const search: SearchClient = {
    async search(q: string) {
      if (q.startsWith("The central bank raised")) {
        return [
          { title: "Central bank raises interest rates fifty basis points to twenty-year high", url: "https://apnews.com/a", snippet: "" },
          { title: "Central bank raises interest rates fifty basis points to a twenty-year high", url: "https://wire.example/b", snippet: "" },
          // deny-tier agreeing is not corroboration
          { title: "Central bank raises interest rates fifty basis points to twenty-year high", url: "https://dnyuz.com/c", snippet: "" },
          // already cited — not independent
          { title: "Central bank raises interest rates fifty basis points to twenty-year high", url: "https://beacon.example/d", snippet: "" },
        ];
      }
      return [{ title: "Unrelated sports roundup", url: "https://apnews.com/x", snippet: "" }];
    },
  };

  const checked = await checkClaims({
    column: "body", llm, search, citedHosts: ["beacon.example"], max: 5,
  });
  ok("two claims checked", checked.length === 2, JSON.stringify(checked.map((c) => c.claim.slice(0, 20))));
  ok("corroboration counts only independent, non-deny hosts",
    checked[0].corroborated &&
      checked[0].corroborating.includes("apnews.com") &&
      checked[0].corroborating.includes("wire.example") &&
      !checked[0].corroborating.includes("dnyuz.com") &&
      !checked[0].corroborating.includes("beacon.example"),
    JSON.stringify(checked[0]));
  ok("an uncorroborated claim is reported, not hidden",
    checked[1].corroborated === false && checked[1].corroborating.length === 0, JSON.stringify(checked[1]));

  const logs: string[] = [];
  await checkClaims({ column: "b", llm, search, citedHosts: [], max: 5, log: (l) => logs.push(l) });
  ok("the weak claim is named in one log line",
    logs.some((l) => l.includes("1/2 claim(s) found no independent corroboration")), JSON.stringify(logs));

  // A dead LLM must not take the run down.
  const dead = { async completeStructured() { throw new Error("model down"); } } as unknown as LlmClient;
  ok("a failure returns [] and never throws",
    (await checkClaims({ column: "b", llm: dead, search, citedHosts: [], max: 3 })).length === 0, "");

  if (failures > 0) { process.exitCode = 1; return; }
  process.stdout.write("claim-check checks: all green\n");
}
main().catch((e: unknown) => { process.stderr.write(`claim-check.checks failed: ${String(e)}\n`); process.exit(1); });
