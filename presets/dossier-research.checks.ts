/** Dossier research, the pure parts: the catalogue parsers, the call checker,
 *  and split-never-cut. Run: npx tsx presets/dossier-research.checks.ts */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatagodClient } from "../clients/datagod";
import { budgetSpent, groupsUnder, itemCount, normQuote, openDoc, parseEndpoints, parseGuide, partBudget, refListed, splitText, unsupportedInDoc, validCall } from "./dossier-research";

let failed = 0;
const ok = (cond: boolean, msg: string, detail = ""): void => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}${cond || detail === "" ? "" : ` — ${detail}`}`);
  if (!cond) failed += 1;
};

const guide = parseGuide("intro\n### NSArchive\nDeclassified documents.\n- **Endpoints**: /nsarchive/search\n### Health\nliveness\n### UCDP\nconflict data\n");
ok(guide.length === 1 && guide[0].name === "NSArchive" && guide[0].description === "Declassified documents.", "parseGuide: a source's name and description, the not-offered ones gone", JSON.stringify(guide));

const rows = parseEndpoints(
  [
    "source,method,path,description,params",
    'NSArchive,GET,/nsarchive/search,"Search, newest first","q (query, string, required); searched_fields (query, string)"',
    "NSArchive,GET,/nsarchive/document/{path},One document,",
    "FRED,GET,/fred/{series_id},A series,limit (query)",
    "Health,GET,/health,Liveness,",
  ].join("\n"),
);
ok(rows.length === 4 && rows[0].description === "Search, newest first" && rows[0].required.join() === "q", "parseEndpoints: quoted commas, parameters, the required ones", JSON.stringify(rows.map((r) => r.required)));

const nsa = validCall({ path: "/nsarchive/search", params: { q: "Iran hostages", searched_fields: "Title", junk: "x" } }, rows);
ok(!("error" in nsa) && nsa.params.q === "Iran AND hostages" && !("junk" in nsa.params), "validCall: NSArchive words are AND-ed, unknown params dropped", JSON.stringify(nsa));
const filled = validCall({ path: "/nsarchive/document/{path}", params: { path: "33209-document-45" } }, rows);
ok(!("error" in filled) && filled.path === "/nsarchive/document/33209-document-45", "validCall: a {placeholder} is filled from its param", JSON.stringify(filled));
ok("error" in validCall({ path: "/nsarchive/search", params: {} }, rows), "validCall: a missing required param is refused");
ok("error" in validCall({ path: "/nowhere", params: { q: "x" } }, rows), "validCall: a path outside the catalogue is refused");
ok("error" in validCall({ path: "/fred/{series_id}", params: {} }, rows), "validCall: an unfilled placeholder is refused");

const text = `${"a".repeat(50)}\n\n${"b".repeat(50)}\n${"c".repeat(120)}`;
const parts = splitText(text, 60);
ok(parts.join("") === text, "splitText: the parts join back to the whole text — nothing cut", String(parts.map((p) => p.length)));
ok(parts.every((p) => p.length <= 60), "splitText: no part over the budget", String(parts.map((p) => p.length)));
ok(parts[0] === `${"a".repeat(50)}\n\n`, "splitText: a paragraph break is preferred", JSON.stringify(parts[0]));
ok(splitText("short", 60).length === 1, "splitText: a short text is one part");

const groups = groupsUnder(["x".repeat(40), "y".repeat(40), "z".repeat(100)], 90);
ok(groups.length === 2 && groups[0].length === 2 && groups[1][0].length === 100, "groupsUnder: packs in order, and an oversized item gets a group of its own, whole", JSON.stringify(groups.map((g) => g.length)));

ok(itemCount({ meta: {}, data: { results: [{ a: 1 }, { a: 2 }] } }) === 2 && itemCount({ results: [] }) === 0, "itemCount: the first non-empty list of objects");
ok(normQuote("It’s  “Done”\n now") === normQuote("its done now"), "normQuote: quotes and spacing do not decide a match");
ok(refListed("frus1964-68v34/213", '{"volume":"frus1964-68v34","doc":"d213"}'), "refListed: a FRUS ref given in two fields is found");
ok(refListed("0001680247-26-000058:exhibit991.htm", '{"_id":"0001680247-26-000058:exhibit991.htm"}'), "refListed: an EDGAR id is found");
ok(!refListed("2026-00002", '{"results":[{"document_number":"2026-19251"}]}'), "refListed: a document no search returned is not");
ok(partBudget(-5) === 50_000 && partBudget(80_000) === 80_000, "partBudget: never under 50,000 characters");
let threw = false;
try {
  splitText("abc", 0);
} catch {
  threw = true;
}
ok(threw, "splitText: a zero budget throws instead of spinning");
const DOC = "Continuation of the National Emergency. Donald J. Trump signed this notice on April 15, 2026, under the Russian Harmful Foreign Activities Sanctions program.";
ok(unsupportedInDoc("President Biden issued the notice on April 15, 2026.", DOC) === "Biden", "unsupportedInDoc: a name the document lacks is caught", String(unsupportedInDoc("President Biden issued the notice", DOC)));
ok(unsupportedInDoc("The notice, signed by Donald Trump in 2026, extends the Russian sanctions program.", DOC) === null, "unsupportedInDoc: a point the document supports passes", String(unsupportedInDoc("The notice, signed by Donald Trump in 2026, extends the Russian sanctions program.", DOC)));
ok(unsupportedInDoc("It was signed on April 17, 2025.", DOC) === "17", "unsupportedInDoc: a number the document lacks is caught (the first one)", String(unsupportedInDoc("It was signed on April 17, 2025.", DOC)));
const DOC2 = "United States-India trade rose 4.5 percent. The duties on India apply to Russian crude; Ukraine's exports were exempt.";
for (const [point, why] of [
  ["Trade between the United States-India partners rose 4.5 percent.", "a hyphenated name and a decimal"],
  ["Indian refiners buy Russian crude. However, Ukrainian grain is exempt.", "demonyms and a second sentence's first word"],
  ["The duties fall on India's imports.", "a possessive"],
] as const) {
  ok(unsupportedInDoc(point, DOC2) === null, `unsupportedInDoc: passes ${why}`, String(unsupportedInDoc(point, DOC2)));
}

const DOC3 = "Duties on India, Korea, Syria, Cuba, Mali, Peru, Norway, Britain, France, Turkey, Greece and the Philippines total 1,500,000,000 dollars. Donald Trump signed it.";
for (const demonym of ["Indian", "Korean", "Syrian", "Cuban", "Malian", "Peruvian", "Norwegian", "British", "French", "Turkish", "Greek", "Filipino"]) {
  ok(unsupportedInDoc(`The duties hit ${demonym} exporters.`, DOC3) === null, `unsupportedInDoc: the demonym ${demonym} matches its country`, String(unsupportedInDoc(`The duties hit ${demonym} exporters.`, DOC3)));
}
ok(unsupportedInDoc("The order was signed by Mr. Biden.", DOC3) === "Biden", "unsupportedInDoc: 'Mr.' does not end a sentence, so Biden is checked", String(unsupportedInDoc("The order was signed by Mr. Biden.", DOC3)));
ok(unsupportedInDoc("The order was signed by Donald J. Biden.", DOC3) === "Biden", "unsupportedInDoc: a middle initial does not end a sentence", String(unsupportedInDoc("The order was signed by Donald J. Biden.", DOC3)));
ok(unsupportedInDoc("The duties total 1.5 billion dollars.", DOC3) === null, "unsupportedInDoc: 1.5 billion matches 1,500,000,000", String(unsupportedInDoc("The duties total 1.5 billion dollars.", DOC3)));

const DOC4 = "Senator Lindsey Graham sold 400 bushels. John Carter's cart changed hands for 1.5 million dollars.";
for (const [point, wrong] of [["The grain went to Mr. Bush.", "Bush"], ["The sale was approved by Johnson.", "Johnson"], ["President Chan approved the sale.", "Chan"]] as const) {
  ok(unsupportedInDoc(point, DOC4) === wrong, `unsupportedInDoc: ${wrong} is not accepted on a word it merely starts`, String(unsupportedInDoc(point, DOC4)));
}
ok(unsupportedInDoc("It was sold by Sen. Lindsey Graham.", DOC4) === null, "unsupportedInDoc: a title abbreviation is not a name", String(unsupportedInDoc("It was sold by Sen. Lindsey Graham.", DOC4)));
ok(unsupportedInDoc("The cart changed hands for 1.5 billion dollars.", DOC4) === "1.5 billion", "unsupportedInDoc: 1.5 billion does not pass on 1.5 million", String(unsupportedInDoc("The cart changed hands for 1.5 billion dollars.", DOC4)));
ok(unsupportedInDoc("The cart changed hands for 3 billion dollars.", DOC4) === "3 billion", "unsupportedInDoc: a single-digit scaled number is checked", String(unsupportedInDoc("The cart changed hands for 3 billion dollars.", DOC4)));

const DOC5 = "Talks between Germany, Belgium, Congo, Slovakia, Iceland, Uzbekistan, Kazakhstan, America, Russia and Iran raised 1.5 billion.";
for (const demonym of ["German", "Belgian", "Congolese", "Slovak", "Icelandic", "Uzbek", "Kazakh", "Americans", "Russians", "Iranians"]) {
  ok(unsupportedInDoc(`The talks included ${demonym} envoys.`, DOC5) === null, `unsupportedInDoc: ${demonym} matches its country`, String(unsupportedInDoc(`The talks included ${demonym} envoys.`, DOC5)));
}
for (const abbr of ["Pres.", "Sec.", "Amb."]) {
  ok(unsupportedInDoc(`The talks were led by ${abbr} Biden.`, DOC5) === "Biden", `unsupportedInDoc: ${abbr} keeps the name after it checked`, String(unsupportedInDoc(`The talks were led by ${abbr} Biden.`, DOC5)));
}
ok(unsupportedInDoc("The talks raised 1.5bn.", DOC5) === null, "unsupportedInDoc: 1.5bn reads as 1.5 billion", String(unsupportedInDoc("The talks raised 1.5bn.", DOC5)));

// The wall-clock budget. Nothing bounded the dossier before, and a run that
// spent 43 minutes on three documents was killed by the desk's 90-minute
// wrapper and published nothing (2026-09-19).
const DEADLINE = 1_000_000;
ok(budgetSpent(DEADLINE, DEADLINE - 1) === "", "budgetSpent: a millisecond left is time enough to start one more");
ok(budgetSpent(DEADLINE, DEADLINE) !== "", "budgetSpent: the deadline itself is spent");
ok(budgetSpent(DEADLINE, DEADLINE + 60_000) !== "", "budgetSpent: past it stays spent");
ok(/budget is spent/.test(budgetSpent(DEADLINE, DEADLINE)), "budgetSpent: says why, for the log", budgetSpent(DEADLINE, DEADLINE));

// The budget reaches INSIDE a document. Checked only between documents, one
// scanned NARA volume (246 MB, every page rendered, then OCR'd) held the
// dossier past the desk's 90-minute cap, twice on 2026-09-24.
/** A PDF of `pages` blank pages: no text layer, so openDoc takes the OCR path. */
function blankPdf(pages: number): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
if (spawnSync("pdftoppm", ["-v"]).error !== undefined) {
  console.log("SKIP openDoc budget: poppler is not installed");
} else {
  const scan = blankPdf(300);
  // /scan.pdf answers at once; /stalled.pdf never answers.
  const server = createServer((req, res) => {
    if (req.url === "/scan.pdf") res.end(scan);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const nara = (url: string): DatagodClient => ({
    get: async () => ({ body: { hits: { hits: [{ _source: { record: { title: "Scan", naId: 1, digitalObjects: [{ objectUrl: url }] } } }] } } }),
    getText: async () => "",
  });
  for (const [what, path] of [["a scanned PDF's render and OCR", "/scan.pdf"], ["a download that never answers", "/stalled.pdf"]] as const) {
    const started = Date.now();
    const outcome = await Promise.race([
      openDoc({ source: "NARA", ref: "1", title: "Scan", why: "" }, nara(`http://127.0.0.1:${port}${path}`), AbortSignal.timeout(1_500)).then(
        () => "opened",
        (err: unknown) => `stopped: ${String(err).slice(0, 90)}`,
      ),
      new Promise<string>((done) => setTimeout(() => done("still running"), 20_000).unref()),
    ]);
    const secs = (Date.now() - started) / 1000;
    ok(outcome.startsWith("stopped") && secs < 10, `openDoc: a 1.5 s budget stops ${what}`, `${outcome} after ${secs.toFixed(1)}s`);
  }
  server.closeAllConnections();
  server.close();
}

if (failed > 0) {
  console.log(`dossier-research checks: ${failed} FAILED`);
  process.exit(1);
}
console.log("dossier-research checks: all green");
