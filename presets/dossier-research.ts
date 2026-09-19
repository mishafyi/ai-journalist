/**
 * Dossier research — the desk's background on each principal, from documents
 * read in full (operator, 2026-09-18: "rate the top sources of documents", "we
 * can't just include titles of documents in the context"; 2026-09-19: build it
 * into the engine, and cut nothing).
 *
 * Per principal:
 *   A. the model scores EVERY DataGod source for documents about the subject;
 *   B. the best-scored sources are searched — the model writes the calls, the
 *      catalogue checks them;
 *   C. the model picks, from what came back, the documents worth reading;
 *   D. each is opened in FULL — PDFs through pdftotext (OCR on every page of a
 *      scan), the Federal Register's own text, the SEC filing, the Wikipedia
 *      article;
 *   E. the model writes notes on every document, its quotes checked word for
 *      word against the document's text.
 *
 * Nothing is cut: a listing, a document or a record too big for one call is
 * split into parts, each read in its own call — never truncated. The source
 * articles (the story's own reporting, whole) ride in every prompt.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as cheerio from "cheerio";
import { z } from "zod";
import type { DatagodClient } from "../clients/datagod";
import type { LlmClient } from "../ports";

const run = promisify(execFile);

/** The dossier's calls run on Flash-Lite only: 500 requests a day per key, and
 *  a million-token window for whole documents (the test that set the design ran
 *  it throughout, 2026-09-18). */
export const DOSSIER_MODEL = "gemini-3.5-flash-lite,gemini-3.1-flash-lite";
/** One call's prompt, in characters (~150K tokens): under Flash-Lite's 250K
 *  tokens a minute per key, so no single request is refused on every key. A
 *  listing, document or record past it is split into parts, never cut. */
export const CALL_BUDGET_CHARS = 600_000;
/** How many sources are searched per principal — the top of the model's
 *  ranking — and the least score one needs. */
export const TOP_SOURCES = 6;
export const MIN_SCORE = 3;
/** Documents opened per principal. */
export const MAX_DOCS = 8;
/** OCR runs this many pages at once. */
const OCR_CONCURRENCY = 4;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const GUIDE_URL = "https://raw.githubusercontent.com/mishafyi/datagod/main/docs/API_GUIDE.md";
const ENDPOINTS_URL = "https://raw.githubusercontent.com/mishafyi/datagod/main/docs/endpoints.csv";

/** Not offered: not data, or failing for a reason no retry fixes. */
export const NOT_OFFERED: Readonly<Record<string, string>> = {
  Health: "not a data source",
  Admin: "not a data source",
  UCDP: "upstream 401: UCDP_ACCESS_TOKEN is not set in DataGod's Coolify env (free registration at ucdp.uu.se)",
};

/** Search rules the catalogue does not state, from DataGod's docs and probes (2026-09-18). */
const SEARCH_TIPS: Readonly<Record<string, string>> = {
  NSArchive:
    'Matches words anywhere in a document and always returns NEWEST FIRST (plain words are OR-ed, so "Hegseth Iran" returns whatever mentions Iran). searched_fields=Title finds documents ABOUT the subject; join words with AND or use a "quoted phrase"; bound the years with field_date_min / field_date_max (YYYY-MM-DD) to reach the period that matters.',
  FRUS: "Relevance-ranked full text of the official diplomatic record; volumes run to the late 1980s.",
  "Federal Register":
    'Newest first; term matches words anywhere in a document, so keep it to one or two words ("Iran", "Hegseth"). doc_type = RULE, PRORULE, NOTICE or PRESDOCU — PRESDOCU is the president\'s own executive orders, proclamations and memoranda.',
  EDGAR: 'Full text of SEC filings since 2001: q is a "quoted phrase" or words; forms (e.g. 10-K,10-Q,8-K); startdt / enddt YYYY-MM-DD.',
  Wikipedia: "/wikipedia/search finds article titles; the article itself is read in full afterwards.",
  NARA: "available_online=true keeps records with digitised files (PDFs) — the ones that can be read.",
  "Wilson Center": "Full-text search of Cold War and international-history documents.",
  CIA: "No search: list one of the collections below with /cia/collection/{slug}.",
  Vault: "No search: open one of the subjects below with /vault/page/{path}.",
  FAS: "No search: open one of the sections below with /fas/index/{path}.",
  USAspending: "Award descriptions rarely name a country: search for the programme, weapon, agency or contractor.",
  Congress: "/congress/bills lists recent bills and cannot search; a bill's detail needs congress/type/number.",
  FEC: "name = a candidate or donor name.",
};

/** What reaches us from each document source, verified 2026-09-18 — the guide
 *  says what a source holds, not what comes back. */
const RETURNS: Readonly<Record<string, string>> = {
  FRUS: "the full text of each document",
  EDGAR: "the full filing",
  "Federal Register": "the full text of each document",
  NSArchive: "each document's PDF, read in full",
  NARA: "digitised records' PDFs, read in full — many records are not digitised",
  CIA: "each document's PDF",
  Wikipedia: "the full article",
  "Wilson Center": "a catalogue record only (title, subjects, names) — DataGod does not serve the text",
  FAS: "a page's text or its PDF",
  Vault: "scanned FBI files — not readable as text",
  Congress: "one bill's record (sponsors, actions, summary), only by its number; members and votes are unfiltered lists",
  "Cross-Reference": "a politician's House disclosures and campaign finance (members of Congress and candidates only), or a company's filings, contracts and donations",
  FEC: "itemised donations by or to a name",
  "House Disclosures": "House members' financial disclosures and stock trades",
  USAspending: "federal awards (contracts, grants) whose descriptions match the words",
};

/** Sources whose results are documents to open; the rest return records. */
export const DOC_SOURCES = ["Federal Register", "NSArchive", "FRUS", "EDGAR", "Wikipedia", "NARA", "Wilson Center", "CIA", "FAS", "Congress"] as const;
const REF_RULES = [
  "Federal Register: the document_number",
  'NSArchive: the path (e.g. "33209-document-45-office-director-…"), never the bare id',
  'FRUS: "volume/doc" (e.g. "frus1964-68v34/213")',
  'EDGAR: the _id exactly (e.g. "0001680247-26-000058:exhibit991.htm") and cik = the first of its ciks',
  "Wikipedia: the article title",
  "NARA: the naId",
  "Wilson Center: the slug",
  "CIA: the document path from the collection listing",
  "FAS: the page path",
  'Congress: "congress/type/number" (e.g. "119/hr/1234")',
].join("\n");
const TEXT_PARAMS = ["q", "query", "term", "keyword", "name", "last_name", "condition", "intervention"];

// ── the catalogue ────────────────────────────────────────────────────────────

export interface CatalogueSource {
  name: string;
  description: string;
}
export interface CatalogueRow {
  source: string;
  path: string;
  description: string;
  params: string;
  names: string[];
  required: string[];
  re: RegExp;
}
export interface Catalogue {
  sources: CatalogueSource[];
  rows: CatalogueRow[];
  /** What CIA, Vault and FAS must be browsed from — their registries, whole. */
  registries: Record<string, string>;
}

/** Pure. Every "### Source" section of DataGod's API_GUIDE.md, minus the ones not offered. */
export function parseGuide(md: string): CatalogueSource[] {
  return md
    .split(/^### /m)
    .slice(1)
    .map((sec) => ({ name: sec.split("\n")[0].trim(), description: sec.split("\n").slice(1).join("\n").split("\n- **Endpoints")[0].trim() }))
    .filter((s) => !(s.name in NOT_OFFERED));
}

function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Pure. DataGod's endpoints.csv: each row's path, its parameters, the required ones, and a matcher. */
export function parseEndpoints(csv: string): CatalogueRow[] {
  return csv
    .split("\n")
    .slice(1)
    .filter((l) => l.trim() !== "")
    .map(csvCells)
    .map((c) => ({ source: c[0] ?? "", path: c[2] ?? "", description: c[3] ?? "", params: c[4] ?? "" }))
    .filter((r) => r.path.startsWith("/"))
    .map((r) => ({
      ...r,
      names: r.params.split(";").map((x) => x.trim().split(" ")[0]).filter((x) => x !== ""),
      required: r.params
        .split(";")
        .filter((x) => /\(query[^)]*required/.test(x))
        .map((x) => x.trim().split(" ")[0]),
      re: new RegExp(`^${r.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}|\{[^}]+\}/g, ".+")}$`),
    }));
}

/** The live catalogue: DataGod's guide and endpoint index from its repository,
 *  and the CIA, Vault and FAS registries from DataGod itself. A registry that
 *  fails is marked UNAVAILABLE, so the plan knows not to browse it. */
export async function loadCatalogue(args: { datagod: DatagodClient; fetchImpl?: typeof fetch; log?: (line: string) => void }): Promise<Catalogue> {
  const doFetch = args.fetchImpl ?? fetch;
  // Three tries, 5 s apart: one slow answer from GitHub must not cost the dossier.
  const text = async (url: string): Promise<string> => {
    let last: unknown = new Error(`dossier: catalogue ${url}: no attempt made`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await doFetch(url, { signal: AbortSignal.timeout(30_000) });
        if (res.ok) return await res.text();
        last = new Error(`dossier: catalogue ${url} → HTTP ${res.status}`);
      } catch (err: unknown) {
        last = err;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
    }
    throw last;
  };
  const [guide, csv] = await Promise.all([text(GUIDE_URL), text(ENDPOINTS_URL)]);
  const registries: Record<string, string> = {};
  for (const [source, path] of [["CIA", "/cia/collections"], ["Vault", "/vault/subjects"], ["FAS", "/fas/sections"]] as const) {
    try {
      registries[source] = JSON.stringify(await args.datagod.get(path, {}));
    } catch (err: unknown) {
      registries[source] = `UNAVAILABLE — ${String(err).slice(0, 200)}`;
      args.log?.(`dossier: registry ${path} failed: ${String(err).slice(0, 200)}`);
    }
  }
  return { sources: parseGuide(guide), rows: parseEndpoints(csv), registries };
}

/** Pure. How a source can be searched, from its endpoints — so a score can weigh what a search can reach. */
export function howToSearch(source: string, rows: readonly CatalogueRow[]): string {
  const mine = rows.filter((r) => r.source === source);
  const byText = mine.filter((r) => r.names.some((n) => TEXT_PARAMS.includes(n)) || /\{(name|last_name|title)\}/.test(r.path));
  const byId = mine.filter((r) => r.path.includes("{") && !byText.includes(r));
  const how =
    byText.length > 0
      ? `by keyword or name — ${byText.map((r) => r.path).join(", ")}`
      : byId.length > 0
        ? `only by an id or code already known — ${byId.map((r) => r.path).join(", ")}`
        : "cannot be searched: it only lists its newest items";
  return `Can search: ${how}.${RETURNS[source] ? ` Returns: ${RETURNS[source]}.` : ""}${SEARCH_TIPS[source] ? ` ${SEARCH_TIPS[source]}` : ""}`;
}

/** Pure. A call as DataGod takes it — its {placeholders} filled from its params, only the params
 *  the catalogue lists for that endpoint, the required ones present — or why it cannot be made. */
export function validCall(
  c: { path: string; params: Record<string, string> },
  rows: readonly CatalogueRow[],
): { path: string; params: Record<string, string>; source: string } | { error: string } {
  const path = String(c.path)
    .split("?")[0]
    .replace(/\{([^}]+)\}/g, (m, k: string) => (c.params[k] === undefined ? m : encodeURIComponent(String(c.params[k]))));
  if (/[{}]/.test(path)) return { error: `unfilled placeholder in ${path}` };
  const row = rows.find((r) => r.re.test(path));
  if (row === undefined) return { error: `not in the catalogue: ${path}` };
  const inPath = [...row.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const query: Record<string, string> = Object.fromEntries(
    Object.entries(c.params).filter(([k, v]) => row.names.includes(k) && !inPath.includes(k) && String(v) !== ""),
  );
  const missing = row.required.filter((k) => !(k in query));
  if (missing.length > 0) return { error: `missing ${missing.join(", ")}` };
  // A listing that cannot name its subject returns the source's newest items, about anything.
  if (inPath.length === 0 && ![...TEXT_PARAMS, "title"].some((k) => k in query)) return { error: "names no subject — no search term and no id" };
  // NSArchive OR-s plain words: "Iran strategic bankruptcy" = anything mentioning Iran.
  if (row.source === "NSArchive" && typeof query.q === "string" && !/"|\bAND\b|\bOR\b/.test(query.q)) query.q = query.q.trim().split(/\s+/).join(" AND ");
  return { path, params: query, source: row.source };
}

/** Pure. How many items a listing holds: the first non-empty array of objects, breadth first. */
export function itemCount(data: unknown): number {
  const queue: unknown[] = [data];
  while (queue.length > 0) {
    const v = queue.shift();
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") return v.length;
    if (v !== null && typeof v === "object") queue.push(...Object.values(v as Record<string, unknown>));
  }
  return 0;
}

/** Pure. `text` in parts of at most `max` characters, split at a paragraph or
 *  line break where one falls in the second half of the part, never dropping a
 *  character: `parts.join("") === text`. */
export function splitText(text: string, max: number): string[] {
  if (!(max > 0)) throw new Error(`splitText: a part must hold at least one character (max ${max})`);
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    if (text.length - at <= max) {
      parts.push(text.slice(at));
      break;
    }
    const window = text.slice(at, at + max);
    const para = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const cut = para >= max / 2 ? para + 2 : line >= max / 2 ? line + 1 : max;
    parts.push(text.slice(at, at + cut));
    at += cut;
  }
  return parts;
}

/** Capitalised words a key point may use that its document need not contain. */
const POINT_STOPWORDS = new Set(
  (
    "the a an and or of in on for to with by from as at it its this that these those he she they his her their " +
    "president senator secretary representative congress house senate federal register department state states united " +
    "government administration act order executive national office agency court january february march april may june " +
    "july august september october november december monday tuesday wednesday thursday friday saturday sunday document " +
    "notice proclamation rule report article section part " +
    // Title abbreviations: "Sen. Lindsey Graham" in a document that writes "Senator".
    "mr mrs ms dr st jr sr gen sen rep gov lt col capt prof rev hon pres sec amb"
  ).split(" "),
);

/** Pure. Lowercase, accents gone, every non-alphanumeric a space. */
const plainWords = (x: string): string =>
  x.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ");

/** Pure. A number as compared: its digits alone ("4.5" and "4,5" are "45"). */
const numberKey = (m: string): string => m.replace(/[^0-9]/g, "");

const SCALES: Readonly<Record<string, number>> = { thousand: 1e3, million: 1e6, mn: 1e6, billion: 1e9, bn: 1e9, trillion: 1e12, tn: 1e12 };

/** Pure. Every number `text` writes, as digit keys: each numeral's digits, and
 *  a numeral with a scale word also as its full value ("1.5 billion" is also
 *  "1500000000"). */
function numberKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(/(\d[\d,.]*\d|\d)(\s*(thousand|million|billion|trillion|mn|bn|tn)\b)?/gi)) {
    keys.add(numberKey(m[1]));
    const scale = m[3] === undefined ? undefined : SCALES[m[3].toLowerCase()];
    const value = Number(m[1].replace(/,/g, ""));
    if (scale !== undefined && Number.isFinite(value)) keys.add(String(Math.round(value * scale)));
  }
  return keys;
}

/** Nationality words whose country is not their stem. */
const DEMONYMS: Readonly<Record<string, readonly string[]>> = {
  british: ["britain", "united kingdom"], english: ["england"], scottish: ["scotland"], welsh: ["wales"], irish: ["ireland"],
  french: ["france"], dutch: ["netherlands", "holland"], swiss: ["switzerland"], spanish: ["spain"], portuguese: ["portugal"],
  greek: ["greece"], turkish: ["turkey", "turkiye"], polish: ["poland"], danish: ["denmark"], swedish: ["sweden"],
  finnish: ["finland"], norwegian: ["norway"], filipino: ["philippines"], thai: ["thailand"], emirati: ["emirates"],
  kuwaiti: ["kuwait"], iraqi: ["iraq"], yemeni: ["yemen"], israeli: ["israel"], pakistani: ["pakistan"], afghan: ["afghanistan"],
  saudi: ["saudi arabia"], kiwi: ["new zealand"], peruvian: ["peru"], argentine: ["argentina"], burmese: ["myanmar", "burma"], belgian: ["belgium"],
};

/** What a demonym adds to its country's name (India+n, Iran+ian, Congo+lese,
 *  Iceland+ic) — and what a country adds to its demonym (German+y,
 *  Slovak+ia, Uzbek+istan, Kazakh+stan). Anything else left over is a
 *  different word: "johnson" is not "john". */
const DEMONYM_ENDING = /^(n|an|ian|ean|ese|lese|i|s|ish|ic)$/;
const COUNTRY_ENDING = /^(y|ia|ium|o|a|e|istan|stan)$/;

/** Abbreviations whose full stop does not end a sentence: "Mr. Biden" is one sentence. */
const SENTENCE_END = /(?<!\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Gen|Sen|Rep|Gov|Lt|Col|Capt|Prof|Rev|Hon|Pres|Sec|Amb|No|U\.S|[A-Z]))[.!?]\s+(?=[A-Z"“])/;

/** Pure. The first capitalised name or multi-digit number in `point` that
 *  `docText` does not contain; null when there is none. A key point is the
 *  model's reading of a document, and a name or number the document lacks is a
 *  claim it did not make ("President Biden issued" a notice Trump signed,
 *  2026-09-19). Names are matched as whole words, leniently where language is:
 *  a sentence's first word (after a real sentence end, never "Mr." or "J."),
 *  a possessive, each part of a hyphenated name, a demonym ("Indian" for a
 *  document that says "India", "British" for "Britain"), accents; numbers by
 *  their digits or their scaled value ("1.5 billion" = "1,500,000,000"). */
export function unsupportedInDoc(point: string, docText: string): string | null {
  const docWords = new Set(plainWords(docText).split(" ").filter((w) => w !== ""));
  const hay = ` ${plainWords(docText)} `;
  const numbers = numberKeys(docText);
  for (const m of point.matchAll(/(\d[\d,.]*\d|\d)(\s*(thousand|million|billion|trillion|mn|bn|tn)\b)?/gi)) {
    // A scaled number is compared by its value alone ("1.5 billion" never
    // passes on a document's "1.5 million"), and even a single digit counts.
    const scale = m[3] === undefined ? undefined : SCALES[m[3].toLowerCase()];
    if (scale !== undefined) {
      const value = String(Math.round(Number(m[1].replace(/,/g, "")) * scale));
      if (!numbers.has(value)) return m[0];
    } else if (numberKey(m[1]).length >= 2 && !numbers.has(numberKey(m[1]))) return m[1];
  }
  // A plural reads as its singular: "Americans" for a document's "America".
  const known = (bare: string): boolean => knownOne(bare) || (bare.length > 4 && bare.endsWith("s") && knownOne(bare.slice(0, -1)));
  const knownOne = (bare: string): boolean => {
    if (docWords.has(bare)) return true;
    // A demonym and its country either way round — only when what is left over
    // is a demonym's ending: "indian" for "india", "iran" for "iranian", but
    // never "johnson" for "john" or "bush" for "bushels".
    // Or its stem does: "ukrainian" → "ukrain", found in "ukraine".
    const stem = bare.replace(/(ian|ean|ese|an|i|n|s)$/, "");
    for (const w of docWords) {
      if (w.length >= 4 && bare.length >= 4 && bare.startsWith(w) && DEMONYM_ENDING.test(bare.slice(w.length))) return true;
      if (w.length >= 4 && bare.length >= 4 && w.startsWith(bare) && (DEMONYM_ENDING.test(w.slice(bare.length)) || COUNTRY_ENDING.test(w.slice(bare.length)))) return true;
      if (stem.length >= 4 && stem !== bare && w.startsWith(stem) && w.length - stem.length <= 2) return true;
    }
    return (DEMONYMS[bare] ?? []).some((country) => hay.includes(` ${country} `));
  };
  for (const sentence of point.split(SENTENCE_END)) {
    const words = sentence.split(/[^A-Za-zÀ-ÿ'’.-]+/).filter((w) => w !== "");
    for (const word of words.slice(1)) {
      for (const part of word.replace(/['’]s$/i, "").split("-")) {
        const bare = plainWords(part).replace(/[^a-z]/g, "");
        if (bare.length < 3 || !/^[A-ZÀ-Þ]/.test(part.replace(/^[^A-Za-zÀ-ÿ]+/, "")) || POINT_STOPWORDS.has(bare)) continue;
        if (!known(bare)) return part.replace(/[^A-Za-zÀ-ÿ]/g, "");
      }
    }
  }
  return null;
}

/** Pure. Lowercase, quotes gone, whitespace single — for checking a quote against its document. */
export const normQuote = (s: string): string =>
  String(s).toLowerCase().replace(/[“”"’‘'`]/g, "").replace(/-\s*\n\s*/g, "").replace(/\s+/g, " ").trim();

// ── reading a document in full ───────────────────────────────────────────────

function htmlText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  $("br, p, div, li, tr, h1, h2, h3, h4, h5, h6, pre").after("\n");
  return $("body").text().replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

/** A document fetched from its publisher. A rate limit or a gateway error is
 *  waited out — the server's Retry-After when it gives one (at most a minute),
 *  else 5 s, then 10 s — before the third failure is thrown (the Federal
 *  Register answered 429 on the first live run, 2026-09-19). */
async function fetchDoc(url: string, timeoutMs: number): Promise<Response> {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return res;
    last = `${url}: HTTP ${res.status}`;
    if (![408, 425, 429, 500, 502, 503, 504].includes(res.status) || attempt === 3) break;
    const after = Number(res.headers.get("retry-after") ?? "");
    await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : attempt * 5000));
  }
  throw new Error(last);
}

async function webText(url: string): Promise<string> {
  const res = await fetchDoc(url, 90_000);
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  // By what the server says it sent: an HTML fragment has no <html> tag to sniff.
  if (/html/i.test(type) || /<(html|body|pre)\b/i.test(body.slice(0, 2000))) return htmlText(body);
  if (/xml/i.test(type)) return cheerio.load(body, { xmlMode: true }).root().text().replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  return body;
}

/** A PDF's whole text. A text layer carries hundreds of characters a page; a
 *  scan carries none, and then EVERY page is read by OCR (Tesseract at 200 dpi,
 *  four pages at a time). */
async function pdfText(url: string): Promise<{ text: string; label: string }> {
  const res = await fetchDoc(url, 180_000);
  const dir = await mkdtemp(join(tmpdir(), "dossier-pdf-"));
  try {
    const file = join(dir, "doc.pdf");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    const info = (await run("pdfinfo", [file], { encoding: "utf8" })).stdout;
    const pages = Number((info.match(/^Pages:\s+(\d+)/m) ?? [])[1] ?? 0);
    const text = (await run("pdftotext", ["-enc", "UTF-8", file, "-"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 })).stdout;
    if (text.replace(/\s/g, "").length >= pages * 100) return { text, label: `PDF, ${pages} pages` };
    await run("pdftoppm", ["-r", "200", "-gray", "-png", file, join(dir, "p")], { maxBuffer: 64 * 1024 * 1024 });
    const images = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    const pageTexts: string[] = [];
    for (let i = 0; i < images.length; i += OCR_CONCURRENCY) {
      const batch = images.slice(i, i + OCR_CONCURRENCY);
      const read = await Promise.all(
        batch.map(async (img) => (await run("tesseract", [join(dir, img), "stdout", "-l", "eng"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout),
      );
      pageTexts.push(...read);
    }
    return { text: pageTexts.join("\n\n"), label: `scanned PDF, ${pages} pages, OCR of all ${images.length}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface Pick {
  source: string;
  ref: string;
  cik?: string;
  title: string;
  why: string;
}
export interface OpenedDoc {
  title: string;
  date: string;
  url: string;
  kind: string;
  text: string;
}

/** One picked document, opened as far as its source allows. */
export async function openDoc(pick: Pick, datagod: DatagodClient): Promise<OpenedDoc> {
  const ref = String(pick.ref ?? "").trim();
  const dg = async (path: string): Promise<Record<string, unknown>> => (await datagod.get(path, {})) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  switch (pick.source) {
    case "Federal Register": {
      // The plain-text URL answers 429 to every client (2026-09-19) while the
      // HTML and XML full texts answer 200: the first that serves, in order,
      // with the govinfo PDF last.
      const d = await dg(`/federal-register/${encodeURIComponent(ref)}`);
      // The record's own facts head the text: a presidential document's body
      // never names its signer, so a note saying who signed it had nothing to
      // be checked against (2026-09-19). DataGod's record carries no signer;
      // the Register's API does.
      let president = "";
      if (s(d.type) === "Presidential Document") {
        try {
          const res = await fetchDoc(`https://www.federalregister.gov/api/v1/documents/${encodeURIComponent(ref)}.json?fields[]=president`, 30_000);
          president = s(((await res.json()) as { president?: { name?: string } }).president?.name);
        } catch (err: unknown) {
          // Not fatal to the document — and said in its header, where the notes and the trace read it.
          president = `(signer unknown: the Register's API did not answer — ${String(err).slice(0, 160)})`;
        }
      }
      const agencies = ((d.agencies ?? []) as { name?: string }[]).map((a) => s(a.name)).filter((x) => x !== "").join("; ");
      const number = s(d.executive_order_number) !== "" ? ` No. ${s(d.executive_order_number)}` : s(d.proclamation_number) !== "" ? ` No. ${s(d.proclamation_number)}` : "";
      const meta = [
        `${s(d.citation)} — ${s(d.type)}${s(d.subtype) === "" ? "" : `, ${s(d.subtype)}${number}`}`,
        president === "" ? "" : `Signed by ${president}${s(d.signing_date) === "" ? "" : ` on ${s(d.signing_date)}`}`,
        `Published ${s(d.publication_date)}${agencies === "" ? "" : ` — ${agencies}`}`,
        s(d.abstract) === "" ? "" : `Abstract: ${s(d.abstract)}`,
      ]
        .filter((x) => x !== "")
        .join("\n");
      const failures: string[] = [];
      for (const [field, kind] of [["body_html_url", "full text (HTML)"], ["full_text_xml_url", "full text (XML)"], ["raw_text_url", "full text"]] as const) {
        if (s(d[field]) === "") continue;
        try {
          return { title: s(d.title), date: s(d.publication_date), url: s(d.html_url), kind, text: `${meta}\n\n${await webText(s(d[field]))}` };
        } catch (err: unknown) {
          failures.push(String(err));
        }
      }
      if (s(d.pdf_url) !== "") {
        const pdf = await pdfText(s(d.pdf_url));
        return { title: s(d.title), date: s(d.publication_date), url: s(d.html_url), kind: pdf.label, text: `${meta}\n\n${pdf.text}` };
      }
      throw new Error(`Federal Register ${ref}: no full text served — ${failures.join("; ")}`);
    }
    case "NSArchive": {
      const d = await dg(`/nsarchive/document/${ref}`);
      if (s(d.pdf_url) !== "") {
        const pdf = await pdfText(s(d.pdf_url));
        return { title: s(d.title), date: s(d.date ?? d.date_text), url: s(d.url), kind: pdf.label, text: `${s(d.description)}\n\n${pdf.text}` };
      }
      return { title: s(d.title), date: s(d.date), url: s(d.url), kind: "page text (no PDF)", text: `${s(d.description)}\n\n${s(d.body)}` };
    }
    case "FRUS": {
      const m = ref.match(/(frus[\w-]+)\/d?(\d+)/);
      if (m === null) throw new Error(`FRUS ref is not volume/doc: ${ref}`);
      const d = await dg(`/frus/document/${m[1]}/${m[2]}`);
      return { title: s(d.title), date: "", url: s(d.url), kind: "full text", text: `${s(d.source_note)}\n\n${s(d.body)}` };
    }
    case "EDGAR": {
      const m = ref.match(/^(\d{10})-?(\d{2})-?(\d{6}):(.+)$/);
      const cik = String(pick.cik ?? "").replace(/\D/g, "").replace(/^0+/, "");
      if (m === null || cik === "") throw new Error(`EDGAR needs ref "accession:file" and a cik, got ${ref} / ${pick.cik ?? ""}`);
      const acc = `${m[1]}${m[2]}${m[3]}`;
      const html = await datagod.getText(`/edgar/document/${cik}/${acc}/${m[4]}`, {});
      return { title: pick.title, date: "", url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${m[4]}`, kind: "full filing", text: htmlText(html) };
    }
    case "Wikipedia": {
      const d = (await datagod.get(`/wikipedia/article/${encodeURIComponent(ref)}`, {})) as { query?: { pages?: { title?: string; extract?: string }[] } };
      const page = d.query?.pages?.[0];
      if (page === undefined) throw new Error(`Wikipedia "${ref}": no page in the answer`);
      const title = s(page.title);
      return { title, date: "", url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, kind: "full article", text: s(page.extract) };
    }
    case "NARA": {
      const d = (await datagod.get(`/nara/record/${encodeURIComponent(ref)}`, {})) as { body?: { hits?: { hits?: { _source?: { record?: Record<string, unknown> } }[] } } };
      const rec = d.body?.hits?.hits?.[0]?._source?.record;
      if (rec === undefined) throw new Error(`NARA ${ref}: no record`);
      const url = `https://catalog.archives.gov/id/${s(rec.naId)}`;
      const all = (rec.digitalObjects ?? []) as { objectUrl?: string }[];
      const pdfs = all.filter((o) => /\.pdf$/i.test(o.objectUrl ?? ""));
      if (pdfs.length === 0) return { title: s(rec.title), date: "", url, kind: "catalogue record (no PDF)", text: JSON.stringify(rec, null, 1) };
      const read: { text: string; label: string }[] = [];
      for (const o of pdfs) read.push(await pdfText(s(o.objectUrl)));
      return { title: s(rec.title), date: "", url, kind: `${read.map((r) => r.label).join(" + ")} (${pdfs.length} of ${all.length} files are PDFs)`, text: read.map((r) => r.text).join("\n\n") };
    }
    case "Wilson Center": {
      const d = await dg(`/wilson/document/${encodeURIComponent(ref)}`);
      return {
        title: s(d.title),
        date: "",
        url: `https://digitalarchive.wilsoncenter.org/document/${s(d.slug)}`,
        kind: "catalogue record — DataGod keeps the text in an archive it does not serve",
        text: JSON.stringify({ info: d.info, subjects: d.subjects, names: d.names }, null, 1),
      };
    }
    case "CIA": {
      const d = await dg(`/cia/document/${ref}`);
      const pdfUrl = s(d.pdf_archived_url) !== "" ? s(d.pdf_archived_url) : s(d.pdf_url);
      if (pdfUrl !== "") {
        const pdf = await pdfText(pdfUrl);
        return { title: s(d.title), date: "", url: s(d.url), kind: pdf.label, text: pdf.text };
      }
      return { title: s(d.title), date: "", url: s(d.url), kind: "page text (no PDF)", text: s(d.body) };
    }
    case "FAS": {
      const d = await dg(`/fas/page/${ref}`);
      const pdfs = (d.pdfs ?? []) as { url?: string }[];
      if (s(d.text).length < 1500 && pdfs.length > 0) {
        const pdf = await pdfText(s(pdfs[0].url));
        return { title: s(d.title), date: "", url: s(pdfs[0].url), kind: pdf.label, text: pdf.text };
      }
      return { title: s(d.title), date: "", url: s(d.url), kind: "page text", text: s(d.text) };
    }
    case "Congress": {
      const m = ref.match(/(\d+)\/(\w+)\/(\d+)/);
      if (m === null) throw new Error(`Congress ref is not congress/type/number: ${ref}`);
      const d = await datagod.get(`/congress/bill/${m[1]}/${m[2]}/${m[3]}`, {});
      return { title: pick.title, date: "", url: `https://www.congress.gov/bill/${m[1]}th-congress/${m[2]}/${m[3]}`, kind: "bill record", text: JSON.stringify(d, null, 1) };
    }
    default:
      throw new Error(`no opener for source "${pick.source}"`);
  }
}

// ── the model calls ──────────────────────────────────────────────────────────

const RatingsSchema = z.object({ ratings: z.array(z.object({ source: z.string(), score: z.number(), why: z.string() })) });
// Parameters as name/value pairs: an object schema listing all of DataGod's
// parameter names was refused (400, 2026-09-18).
const PlanSchema = z.object({
  calls: z.array(z.object({ source: z.string(), path: z.string(), params: z.array(z.object({ name: z.string(), value: z.string() })), why: z.string() })),
});
const PicksSchema = z.object({
  picks: z.array(z.object({ source: z.string(), ref: z.string(), cik: z.string().optional(), title: z.string(), why: z.string() })),
});
const NotesSchema = z.object({
  summary: z.string(),
  documents: z.array(z.object({ doc: z.string(), relevant: z.boolean(), key_points: z.array(z.string()), quotes: z.array(z.string()) })),
  records: z.array(z.object({ rec: z.string(), key_points: z.array(z.string()) })),
});

export interface ResearchedDoc {
  id: string;
  source: string;
  title: string;
  date: string;
  url: string;
  kind: string;
  chars: number;
  why: string;
  relevant: boolean;
  keyPoints: string[];
  /** Quotes found word for word in the document's text; `quotesDropped` were not. */
  quotes: string[];
  quotesDropped: number;
  /** Key points naming a name or number the document lacks (`unsupportedInDoc`). */
  pointsDropped: number;
}
export interface PrincipalResearch {
  summary: string;
  documents: ResearchedDoc[];
  records: { id: string; source: string; call: string; keyPoints: string[] }[];
  /** For the trace: every source's score, and each search as it went. */
  ratings: { source: string; score: number; why: string }[];
  searches: { source: string; call: string; outcome: string }[];
}

interface Subject {
  name: string;
  kind: string;
  role: string;
}

/** Everything read for one principal: rate, search, pick, open, notes. */
export async function researchOne(args: {
  llm: LlmClient;
  datagod: DatagodClient;
  catalogue: Catalogue;
  principal: Subject;
  headline: string;
  storyText: string;
  /** Documents already opened this run, by source|ref — a second principal
   *  reads the same text under the same id. Mutated: new documents are added. */
  opened: Map<string, { id: string; doc: OpenedDoc }>;
  nextDocId: () => string;
  log?: (line: string) => void;
}): Promise<PrincipalResearch> {
  const { llm, datagod, catalogue, principal: p, headline, storyText } = args;
  const log = args.log ?? ((): void => undefined);
  const subject = `${p.name} (${p.kind}; in today's story: ${p.role})`;
  const ask = <T>(schema: z.ZodType<T>, schemaName: string, prompt: string, temperature: number): Promise<T> =>
    llm.completeStructured({ messages: [{ role: "user", content: prompt }], schema, schemaName, temperature, model: DOSSIER_MODEL });

  // A. every source, scored
  const rated = await ask(
    RatingsSchema,
    "dossier_rate_sources",
    `You are the research editor preparing a newspaper's background dossier on ${subject}.\n\nTODAY'S STORY — the source articles:\n\n${storyText}\n\n` +
      `Below is EVERY source in our research data gateway and what it holds. Score EVERY source from 0 to 10 for how likely it is to hold interesting DOCUMENTS ABOUT ${p.name} — texts and records in which ${p.name} itself is the subject: official acts, filings, declassified or archival papers, diplomatic records, contracts, votes, disclosures, reference articles — that a reader of today's story does not already have. ` +
      `This is a search for DOCUMENTS — texts. A source of statistics or price series scores at most 4, however relevant its numbers. For a country, a government or an institution, its own official acts and its diplomatic, intelligence and archival record count as documents about it. A source that cannot be searched for ${p.name} scores low. 0 means it holds nothing about ${p.name}. One line of reasoning each.\n\n` +
      catalogue.sources.map((s) => `### ${s.name}\n${s.description}\n${howToSearch(s.name, catalogue.rows)}`).join("\n\n") +
      `\n\nReturn JSON: {"ratings": [{"source", "score", "why"}]} with one entry for EVERY source above, named exactly as its heading.`,
    0.2,
  );
  // One score per source — the highest the model gave it — for sources in the catalogue.
  const bestBySource = new Map<string, { source: string; score: number; why: string }>();
  for (const r of rated.ratings) {
    if (!catalogue.sources.some((s) => s.name === r.source)) continue;
    const prev = bestBySource.get(r.source);
    if (prev === undefined || r.score > prev.score) bestBySource.set(r.source, r);
  }
  const ratings = [...bestBySource.values()].sort((a, b) => b.score - a.score);
  const top = ratings.filter((r) => r.score >= MIN_SCORE).slice(0, TOP_SOURCES);
  log(`dossier: ${p.name} — sources rated ${ratings.length}/${catalogue.sources.length}; top: ${top.map((r) => `${r.source} ${r.score}`).join(", ")}`);

  // B. search the top sources
  const searches: PrincipalResearch["searches"] = [];
  const listings: { source: string; call: string; data: unknown; items: number }[] = [];
  const directPicks: Pick[] = [];
  if (top.length > 0) {
    const plan = await ask(
      PlanSchema,
      "dossier_plan_searches",
      `You are researching ${subject} for the story "${headline}".\n\nSearch these sources for documents about ${p.name}. For each, give one or two calls that LIST documents about ${p.name} — the endpoint, and its parameters by the names listed. Put ids into the {placeholders} of the path. ` +
        `Every call must target ${p.name}: search for ${p.name} by name — or, when ${p.name} is a country, a government or an institution, search its own documents for the story's subject (a president's executive orders and proclamations on Iran: Federal Register doc_type=PRESDOCU, term=Iran). A call that lists recent items about nothing in particular is refused. Follow each source's search rules.\n\n` +
        top
          .map((r) => {
            const lines = catalogue.rows.filter((row) => row.source === r.source).map((row) => `  ${row.path} — ${row.description} — params: ${row.params || "none"}`).join("\n");
            const reg = catalogue.registries[r.source] === undefined ? "" : `\n  Available: ${catalogue.registries[r.source]}`;
            return `### ${r.source} (scored ${r.score}: ${r.why})\n${lines}\n  ${howToSearch(r.source, catalogue.rows)}${reg}`;
          })
          .join("\n\n") +
        `\n\nReturn JSON: {"calls": [{"source", "path", "params": [{"name", "value"}], "why"}]}`,
      0.2,
    );
    for (const planned of plan.calls) {
      const call = { path: planned.path, params: Object.fromEntries(planned.params.map((x) => [x.name, x.value])) };
      const v = validCall(call, catalogue.rows);
      const label = `${call.path} ${JSON.stringify(call.params)}`;
      if ("error" in v) {
        searches.push({ source: planned.source, call: label, outcome: `refused: ${v.error}` });
        continue;
      }
      // An article named outright is a document, not a listing: read it in full.
      if (v.path.startsWith("/wikipedia/summary/")) {
        const title = decodeURIComponent(v.path.slice("/wikipedia/summary/".length)).replace(/_/g, " ");
        directPicks.push({ source: "Wikipedia", ref: title, title, why: planned.why });
        searches.push({ source: "Wikipedia", call: label, outcome: "an article to read in full" });
        continue;
      }
      try {
        const data = await datagod.get(v.path, v.params);
        const items = itemCount(data);
        listings.push({ source: v.source, call: `${v.path} ${JSON.stringify(v.params)}`, data, items });
        searches.push({ source: v.source, call: `${v.path} ${JSON.stringify(v.params)}`, outcome: `${items} items` });
      } catch (err: unknown) {
        searches.push({ source: v.source, call: `${v.path} ${JSON.stringify(v.params)}`, outcome: `failed: ${String(err).slice(0, 300)}` });
      }
    }
  }

  // C. pick the documents — every listing whole, in as many calls as the budget needs
  const isDocSource = (s: string): boolean => (DOC_SOURCES as readonly string[]).includes(s);
  const docListings = listings.filter((l) => isDocSource(l.source) && l.items > 0);
  const recordListings = listings.filter((l) => !isDocSource(l.source) && l.items > 0);
  const pickHead = `You are researching ${subject} for the story "${headline}".\n\nTODAY'S STORY — the source articles:\n\n${storyText}\n\nWHAT THE SEARCHES RETURNED:\n\n`;
  const pickTail =
    `\n\nPick up to ${MAX_DOCS} documents to read IN FULL for the dossier on ${p.name}, most interesting first: the ones most likely to tell a reader something about ${p.name} that today's story does not. Prefer documents whose full text can be read; a catalogue record is a title and a few fields. Only documents listed above, each once. ref is the document's id copied exactly as the results give it:\n${REF_RULES}\n\n` +
    `Return JSON: {"picks": [{"source", "ref", "cik", "title", "why"}]}`;
  const pickBudget = partBudget(CALL_BUDGET_CHARS - pickHead.length - pickTail.length);
  const listingTexts = docListings.flatMap((l, i) => {
    const header = `[L${i + 1}] ${l.source} — ${l.call}\nOpening one returns: ${RETURNS[l.source] ?? "its record"}`;
    const parts = splitText(JSON.stringify(l.data), partBudget(pickBudget - header.length - 40));
    return parts.map((part, n) => `${header}${parts.length > 1 ? ` — part ${n + 1} of ${parts.length}` : ""}\n${part}`);
  });
  const listed = docListings.map((l) => JSON.stringify(l.data)).join("\n");
  const picks: Pick[] = [...directPicks];
  for (const group of groupsUnder(listingTexts, pickBudget)) {
    const picked = await ask(PicksSchema, "dossier_pick_documents", `${pickHead}${group.join("\n\n")}${pickTail}`, 0.2);
    for (const x of picked.picks) {
      // A pick is only a document the searches returned: its ref must appear in
      // a listing (two EPA rules were opened for Russia from nowhere, 2026-09-19).
      if (!refListed(x.ref, listed)) {
        log(`dossier: ${p.name} — pick "${x.title}" (${x.source} ${x.ref}) is in no listing — skipped`);
        continue;
      }
      picks.push({ ...x, source: canonicalSource(x.source) });
    }
  }

  // D. open each in full
  const seen = new Set<string>();
  const unique = picks.filter((x) => {
    const key = pickKey(x);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const docs: { id: string; pick: Pick; doc: OpenedDoc }[] = [];
  for (const pick of unique.slice(0, MAX_DOCS)) {
    const key = pickKey(pick);
    const again = args.opened.get(key);
    if (again !== undefined) {
      docs.push({ id: again.id, pick, doc: again.doc });
      continue;
    }
    const id = args.nextDocId();
    try {
      const doc = await openDoc(pick, datagod);
      const kept = { ...doc, text: doc.text.trim() };
      if (kept.text === "") throw new Error("the document carried no text");
      args.opened.set(key, { id, doc: kept });
      docs.push({ id, pick, doc: kept });
      log(`dossier: ${p.name} — ${id} ${pick.source}: ${kept.title} (${kept.kind}, ${kept.text.length.toLocaleString()} chars)`);
    } catch (err: unknown) {
      log(`dossier: ${p.name} — ${id} ${pick.source} ${pick.ref} could not be opened: ${String(err).slice(0, 200)}`);
    }
  }

  // E. notes on every document and record, whole, in as many calls as the budget needs
  const records = recordListings.map((l, i) => ({ id: `R${i + 1}`, source: l.source, call: l.call, json: JSON.stringify(l.data) }));
  if (docs.length + records.length === 0) {
    return { summary: "", documents: [], records: [], ratings, searches };
  }
  const notesHead = `You are researching ${subject} for a dossier behind the story "${headline}".\n\nTODAY'S STORY — the source articles:\n\n${storyText}\n\n`;
  const notesTail =
    `Write the research on ${p.name}. The dossier already carries the source articles: never repeat what they say — write only what the documents and records ADD.\n- summary: who or what ${p.name} is and what these documents and records show about them — record, money, past actions, positions, controversies — and anything that bears on today's story.\n` +
    `- documents: for EVERY document, relevant (false when it holds nothing about ${p.name} or today's story), key_points (what it says that matters, with dates, names and numbers), and quotes (up to 3 sentences copied EXACTLY, character for character, from its text — statements a reporter would cite, never a title or a heading).\n- records: for every record set, its key_points.\n\n` +
    `Return JSON: {"summary", "documents": [{"doc", "relevant", "key_points", "quotes"}], "records": [{"rec", "key_points"}]}`;
  const items: string[] = [];
  for (const d of docs) {
    const header = `[${d.id}] ${d.doc.title} — ${d.pick.source}${d.doc.date ? `, ${d.doc.date}` : ""} — ${d.doc.url} (${d.doc.kind}, ${d.doc.text.length.toLocaleString()} chars)`;
    const parts = splitText(d.doc.text, partBudget(CALL_BUDGET_CHARS - notesHead.length - notesTail.length - header.length - 200));
    parts.forEach((part, i) => items.push(`${header}${parts.length > 1 ? ` — part ${i + 1} of ${parts.length}` : ""}\n${part}`));
  }
  for (const r of records) {
    const header = `[${r.id}] ${r.source} records — ${r.call}`;
    const parts = splitText(r.json, partBudget(CALL_BUDGET_CHARS - notesHead.length - notesTail.length - header.length - 200));
    parts.forEach((part, i) => items.push(`${header}${parts.length > 1 ? ` — part ${i + 1} of ${parts.length}` : ""}\n${part}`));
  }
  const summaries: string[] = [];
  const noteByDoc = new Map<string, { relevant: boolean; keyPoints: string[]; quotes: string[] }>();
  const noteByRec = new Map<string, string[]>();
  for (const group of groupsUnder(items, CALL_BUDGET_CHARS - notesHead.length - notesTail.length)) {
    const notes = await ask(NotesSchema, "dossier_notes", `${notesHead}DOCUMENTS AND RECORDS, in full:\n\n${group.join("\n\n=====\n\n")}\n\n${notesTail}`, 0.3);
    if (notes.summary.trim() !== "") summaries.push(notes.summary.trim());
    for (const n of notes.documents) {
      const id = `D${(String(n.doc).match(/\d+/) ?? [""])[0]}`;
      const prev = noteByDoc.get(id) ?? { relevant: false, keyPoints: [], quotes: [] };
      noteByDoc.set(id, { relevant: prev.relevant || n.relevant, keyPoints: [...prev.keyPoints, ...n.key_points], quotes: [...prev.quotes, ...n.quotes] });
    }
    for (const r of notes.records) {
      const id = `R${(String(r.rec).match(/\d+/) ?? [""])[0]}`;
      noteByRec.set(id, [...(noteByRec.get(id) ?? []), ...r.key_points]);
    }
  }
  const documents: ResearchedDoc[] = docs.map((d) => {
    const note = noteByDoc.get(d.id) ?? { relevant: false, keyPoints: [], quotes: [] };
    const text = normQuote(d.doc.text);
    const kept = note.quotes.filter((q) => text.includes(normQuote(q)));
    const points = note.keyPoints.filter((k) => unsupportedInDoc(k, d.doc.text) === null);
    return {
      id: d.id,
      source: d.pick.source,
      title: d.doc.title,
      date: d.doc.date,
      url: d.doc.url,
      kind: d.doc.kind,
      chars: d.doc.text.length,
      why: d.pick.why,
      relevant: note.relevant,
      keyPoints: points,
      quotes: kept,
      quotesDropped: note.quotes.length - kept.length,
      pointsDropped: note.keyPoints.length - points.length,
    };
  });
  return {
    summary: summaries.join("\n\n"),
    documents,
    records: records.map((r) => ({ id: r.id, source: r.source, call: r.call, keyPoints: noteByRec.get(r.id) ?? [] })),
    ratings,
    searches,
  };
}

/** Pure. The room a part gets beside a prompt's fixed text — never under
 *  50,000 characters, so a very long source-article block still leaves each
 *  document part a real size (the call runs over the budget then; nothing is
 *  cut to fit). */
export function partBudget(room: number): number {
  return Math.max(50_000, room);
}

/** Pure. Whether a picked `ref` appears in what the searches returned: every
 *  part of it (split at "/" and ":") of three or more characters is found in
 *  the listings, compared without case, dashes, underscores or spaces — so a
 *  FRUS "frus1964-68v34/213" matches a listing that gives the volume and the
 *  document number in separate fields. */
export function refListed(ref: string, listed: string): boolean {
  const key = (s: string): string => s.toLowerCase().replace(/[\s_\\-]+/g, "");
  const hay = key(listed);
  const parts = String(ref).split(/[/:]/).map(key).filter((x) => x.length >= 3);
  return parts.length > 0 && parts.every((x) => hay.includes(x));
}

/** Pure. `items` packed, in order, into groups whose joined length stays under
 *  `budget`; an item over the budget on its own gets a group of its own (the
 *  caller splits long texts first, so none is ever cut here). */
export function groupsUnder(items: readonly string[], budget: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && size + item.length > budget) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.length + 8;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** The model names a source as it likes ("wikipedia", "federal-register"); the openers use the catalogue's names. */
function canonicalSource(name: string): string {
  const key = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");
  return DOC_SOURCES.find((d) => key(d) === key(name)) ?? name;
}
const pickKey = (x: Pick): string => `${x.source}|${String(x.ref).toLowerCase().replace(/_/g, " ").trim()}`;

/** Pure. One principal's research as the later prompts read it: the summary,
 *  then each relevant document with its key points and verified quotes, then
 *  the record sets. */
export function researchText(r: PrincipalResearch): string {
  return [
    r.summary,
    ...r.documents
      .filter((d) => d.relevant)
      .map((d) =>
        [`[${d.id}] ${d.title} — ${d.source}${d.date ? `, ${d.date}` : ""} — ${d.url}`, ...d.keyPoints.map((k) => `  - ${k}`), ...d.quotes.map((q) => `  > "${q.replace(/\s+/g, " ")}"`)].join("\n"),
      ),
    ...r.records.filter((x) => x.keyPoints.length > 0).map((x) => [`[${x.id}] ${x.source} records — ${x.call}`, ...x.keyPoints.map((k) => `  - ${k}`)].join("\n")),
  ]
    .filter((x) => x.trim() !== "")
    .join("\n\n");
}
