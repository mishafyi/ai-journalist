/** Dossier research, the pure parts: the catalogue parsers, the call checker,
 *  and split-never-cut. Run: npx tsx presets/dossier-research.checks.ts */
import { groupsUnder, itemCount, normQuote, parseEndpoints, parseGuide, splitText, validCall } from "./dossier-research";

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

if (failed > 0) {
  console.log(`dossier-research checks: ${failed} FAILED`);
  process.exit(1);
}
console.log("dossier-research checks: all green");
