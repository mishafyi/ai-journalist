import { provenanceOf } from "./provenance";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };
  // The case that started this: a lookalike domain is denied while the real
  // paper it imitates stays allowed.
  ok("telegraph.com (impersonator) is denied", provenanceOf("telegraph.com") === "deny", provenanceOf("telegraph.com"));
  ok("telegraph.co.uk (the real Telegraph) is allowed", provenanceOf("www.telegraph.co.uk") === "allow", provenanceOf("www.telegraph.co.uk"));
  ok("edition.cnn.com inherits cnn.com", provenanceOf("edition.cnn.com") === "allow", provenanceOf("edition.cnn.com"));
  ok("scrapers and aggregators are denied",
    ["dnyuz.com", "aivanet.com", "newsbreak.com", "ground.news", "biztoc.com"].every((h) => provenanceOf(h) === "deny"), "");
  ok("social platforms are denied", ["youtube.com", "x.com", "reddit.com", "instagram.com"].every((h) => provenanceOf(h) === "deny"), "");
  ok(".gov / .edu / .ac.uk are allowed without listing",
    ["justice.gov", "med.stanford.edu", "ox.ac.uk", "nasa.gov"].every((h) => provenanceOf(h) === "allow"), "");
  ok("a host on neither list is unknown, not denied",
    provenanceOf("smalltownledger.com") === "unknown", provenanceOf("smalltownledger.com"));
  ok("empty host is denied", provenanceOf("") === "deny", "");
  // A deny entry must never accidentally swallow a real outlet by suffix.
  ok("suffix matching cannot leak: notyahoo.com is unknown, not denied",
    provenanceOf("notyahoo.com") === "unknown", provenanceOf("notyahoo.com"));
  if (failures > 0) { process.exitCode = 1; return; }
  process.stdout.write("provenance checks: all green\n");
}
main().catch((err: unknown) => { process.stderr.write(`provenance.checks failed: ${String(err)}\n`); process.exit(1); });
