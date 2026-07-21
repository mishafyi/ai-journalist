import { checkAnalysisContract, NO_PARALLEL_PHRASE, DISANALOGY_MARKER } from "./gates";

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

As BBC reported, fees tripled; CNN adds that insurers repriced within a week. The dynamic echoes the Suez Crisis: a chokepoint turned into leverage.

${DISANALOGY_MARKER} Unlike 1956, no state actor has physically seized the waterway — the pressure is priced in, not imposed by occupation, and the coalition landscape is entirely different.`;

  const pass = checkAnalysisContract(GOOD, { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract: compliant analysis passes", pass.ok, pass.failures.join("|"));

  const noLabel = checkAnalysisContract(GOOD.replace("## Analysis — The Historian", "## My take"),
    { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract: missing persona label fails", !noLabel.ok && noLabel.failures.some((f) => f.includes("Analysis —")), noLabel.failures.join("|"));

  const oneOutlet = checkAnalysisContract(GOOD.replace("CNN adds that insurers repriced within a week", "insurers repriced"),
    { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract: <2 outlet citations fails", !oneOutlet.ok && oneOutlet.failures.some((f) => f.includes("≥2")), oneOutlet.failures.join("|"));

  const noParallelNamed = checkAnalysisContract(GOOD.replace(/Suez Crisis/g, "that old canal affair"),
    { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract: parallel not named fails", !noParallelNamed.ok, noParallelNamed.failures.join("|"));

  const noDisanalogy = checkAnalysisContract(GOOD.replace(DISANALOGY_MARKER, "In closing,"),
    { personaName: "The Historian", outletNames: OUTLETS, parallelEvent: "Suez Crisis" });
  ok("contract: missing disanalogy marker fails", !noDisanalogy.ok, noDisanalogy.failures.join("|"));

  const honest = `## Analysis — The Historian\n\nBBC and NPR both document the repricing. ${NO_PARALLEL_PHRASE} What the evidence supports on its own terms: risk premiums are doing the work sanctions once did.`;
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
