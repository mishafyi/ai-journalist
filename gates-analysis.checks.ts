import { checkAnalysisContract, NO_PARALLEL_PHRASE, DISANALOGY_MARKER, BOTTOM_LINE_MARKER } from "./gates";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const OUTLETS = ["BBC", "CNN", "NPR"] as const;
  const GOOD = `## Analysis — The Historian

Chokepoints have never been neutral infrastructure — they are leverage, and every power that has held one has eventually priced it. The Suez Crisis proved the pattern: control the artery and the world pays your politics. The same logic is repricing today's trade.

${DISANALOGY_MARKER} Unlike 1956, no canal has been seized — the modern lever is insurance pricing, which reverses far faster than occupations do.

${BOTTOM_LINE_MARKER} Risk premiums are now doing openly what blockades once did covertly, and they will outlast the shooting.`;

  const pass = checkAnalysisContract(GOOD, { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract: compliant analysis passes", pass.ok, pass.failures.join("|"));

  const noLabel = checkAnalysisContract(GOOD.replace("## Analysis — The Historian", "## My take"),
    { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract: missing persona label fails", !noLabel.ok && noLabel.failures.some((f) => f.includes("Analysis —")), noLabel.failures.join("|"));

  const cites = checkAnalysisContract(GOOD.replace("every power that has held one", "as BBC reported, every power that has held one"),
    { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract v2: citing a news outlet fails", !cites.ok && cites.failures.some((f) => f.includes("must NOT cite")), cites.failures.join("|"));
  const noVerdict = checkAnalysisContract(GOOD.replace(BOTTOM_LINE_MARKER, "**In sum:**"),
    { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract v2: missing bottom-line verdict fails", !noVerdict.ok && noVerdict.failures.some((f) => f.includes("bottom line") || f.includes("The bottom line")), noVerdict.failures.join("|"));

  const noParallelNamed = checkAnalysisContract(GOOD.replace(/Suez Crisis/g, "that old canal affair"),
    { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract: parallel not named fails", !noParallelNamed.ok, noParallelNamed.failures.join("|"));

  const noDisanalogy = checkAnalysisContract(GOOD.replace(DISANALOGY_MARKER, "In closing,"),
    { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract: missing disanalogy marker fails", !noDisanalogy.ok, noDisanalogy.failures.join("|"));

  const honest = `## Analysis — The Historian\n\nHistory offers no clean twin for this moment. ${NO_PARALLEL_PHRASE} On its own terms, the evidence points one way: risk premiums are doing the work sanctions once did.\n\n${BOTTOM_LINE_MARKER} The market, not any navy, will decide how long this lasts.`;
  ok("contract: honest no-parallel path passes",
    checkAnalysisContract(honest, { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: null }).ok,
    "honest path");
  ok("contract: no-parallel WITHOUT the honest phrase fails",
    !checkAnalysisContract(honest.replace(NO_PARALLEL_PHRASE, ""), { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: null }).ok,
    "must state it verbatim");

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("gates-analysis checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`gates-analysis.checks failed: ${String(err)}\n`);
  process.exit(1);
});
