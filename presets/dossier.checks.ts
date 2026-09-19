/** The people dossier: principals from the source articles, research from
 *  documents read in full (stubbed end to end), connections, hypotheses, the
 *  prompt block, and its place in the column prompt.
 *  Run: npx tsx presets/dossier.checks.ts */
import { NO_PARALLEL_PHRASE } from "../gates";
import type { DatagodClient } from "../clients/datagod";
import type { LlmClient } from "../ports";
import type { PersonaProfile } from "../ports";
import {
  composeAuthorVersion,
  dossierRecord,
  findConnections,
  namePrincipals,
  projectHypotheses,
  researchPrincipals,
  sourceArticles,
} from "./news-desk";

let failed = 0;
const ok = (cond: boolean, msg: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed += 1;
};

const ARTICLE = "Nicolás Maduro released photos from the Metropolitan Detention Center in Brooklyn on Friday.";
const WIKI = "Nicolás Maduro is a Venezuelan politician. He governed Venezuela from 2013 until his arrest in 2026, and the oil concessions he signed outlived him.";

const canned: Record<string, unknown> = {
  story_principals: {
    principals: [
      { name: "Nicolás Maduro", kind: "person", role: "deposed president, detained in Brooklyn" },
      { name: "Venezuela", kind: "country", role: "the state he ran" },
    ],
  },
  dossier_rate_sources: { ratings: [{ source: "Wikipedia", score: 9, why: "the reference article" }, { source: "FRED", score: 1, why: "numbers only" }] },
  dossier_plan_searches: { calls: [{ source: "Wikipedia", path: "/wikipedia/search", params: [{ name: "q", value: "Nicolás Maduro" }], why: "find the article" }] },
  dossier_pick_documents: { picks: [{ source: "wikipedia", ref: "Nicolás Maduro", title: "Nicolás Maduro", why: "his record" }] },
  dossier_notes: {
    summary: "Maduro governed Venezuela from 2013; his oil concessions outlived him.",
    documents: [
      {
        doc: "D1",
        relevant: true,
        key_points: ["Governed Venezuela 2013–2026"],
        quotes: ["the oil concessions he signed outlived him", "a sentence that is not in the article"],
      },
    ],
    records: [],
  },
  story_connections: {
    connections: [
      { between: ["Nicolás Maduro", "Venezuela"], connection: "He signed the concessions the deal now allocates.", why_it_matters: "the oil is the leverage", in_story: false, rests_on: "[D1]" },
      { between: ["Nicolás Maduro", "Brooklyn"], connection: "He is detained there.", why_it_matters: "the photos", in_story: true, rests_on: "the articles" },
    ],
  },
  story_hypotheses: {
    hypotheses: [
      {
        hypothesis: "The trial date becomes the bargaining chip in the oil talks.",
        timeframe: "months",
        precedent: "Manuel Noriega, 1990",
        precedent_outcome: "tried in Miami while Panama's new government bargained",
        why_it_applies: "a deposed leader held by the US",
        how_it_differs: "oil",
        would_be_wrong_if: "the trial opens before any deal",
        rests_on: "[D1]; Maduro / Venezuela",
      },
    ],
  },
};
const prompts: string[] = [];
const structured: { schemaName: string; content: string; model?: string }[] = [];
const column = `## The Photographs Were the Message, Not the Man\n\n${"word ".repeat(200)}Reuters and AP reported it. ${NO_PARALLEL_PHRASE}\n\n## What a Brooklyn Cell Cannot Contain\n\n${"word ".repeat(150)}`;
const llm: LlmClient = {
  async complete({ prompt }) {
    prompts.push(prompt);
    return column;
  },
  async completeStructured<T>({ messages, schema, schemaName, model }: { messages: { content: string }[]; schema: { parse(v: unknown): T }; schemaName: string; model?: string }): Promise<T> {
    structured.push({ schemaName, content: messages.map((m) => m.content).join("\n"), ...(model === undefined ? {} : { model }) });
    return schema.parse(canned[schemaName]);
  },
};

const headline = "Venezuela's Maduro shares first photos from US detention";
const storyText = sourceArticles([{ outlet: "Reuters", title: "Maduro photos", url: "https://reuters.test/maduro", content: ARTICLE }]);
ok(storyText.includes("SOURCE: Reuters — Maduro photos — https://reuters.test/maduro") && storyText.includes(ARTICLE), "sourceArticles: each page's outlet, title, URL and whole text");

const principals = await namePrincipals({ llm, headline, storyText });
ok(principals.length === 2 && principals.some((p) => p.kind === "country"), "principals: people and countries both come through");
ok(structured[0].content.includes(ARTICLE) && !structured[0].content.includes("EVIDENCE"), "principals are named from the source articles, not evidence bullets");

const bare = await researchPrincipals({ llm, principals, headline, storyText });
ok(bare.every((e) => e.research === "" && e.detail === null), "no DataGod → nothing on file for anyone");

// The research, stubbed end to end: the catalogue from DataGod's repository,
// a search, a pick, the whole Wikipedia article, notes with one quote that is
// in it and one that is not.
const GUIDE = "# DataGod\n\n### Wikipedia\nThe encyclopedia.\n- **Endpoints**: ...\n\n### FRED\nEconomic series.\n\n### Health\nnot data\n";
const CSV = [
  "source,method,path,description,params",
  "Wikipedia,GET,/wikipedia/search,Search articles,\"q (query, string, required)\"",
  "Wikipedia,GET,/wikipedia/article/{title},The whole article,",
  "FRED,GET,/fred/{series_id},A series,limit (query)",
].join("\n");
const fetchImpl = (async (url: unknown) =>
  new Response(String(url).endsWith("API_GUIDE.md") ? GUIDE : CSV, { status: 200 })) as typeof fetch;
const dgCalls: string[] = [];
const datagod: DatagodClient = {
  async get(path, params) {
    dgCalls.push(`${path} ${JSON.stringify(params ?? {})}`);
    if (path === "/wikipedia/search") return { results: [{ title: "Nicolás Maduro", snippet: "…" }] };
    if (path.startsWith("/wikipedia/article/")) return { query: { pages: [{ title: "Nicolás Maduro", extract: WIKI }] } };
    return {};
  },
  async getText() {
    return "";
  },
};
structured.length = 0;
const logs: string[] = [];
const entries = await researchPrincipals({ llm, principals: principals.slice(0, 1), headline, storyText, datagod, fetchImpl, log: (l) => logs.push(l) });
const entry = entries[0];
ok(dgCalls.some((c) => c.startsWith('/wikipedia/search {"q":"Nicolás Maduro"}')), `the planned search ran through the catalogue check (${dgCalls.join(" | ")})`);
ok(dgCalls.some((c) => c.startsWith("/wikipedia/article/")), "the picked article was opened in full");
ok(entry.detail?.documents[0]?.chars === WIKI.length, "the document is read whole — every character");
ok(entry.research.includes("the oil concessions he signed outlived him") && !entry.research.includes("not in the article"), "a quote found word for word is kept; one that is not is dropped");
ok(entry.detail?.documents[0]?.quotesDropped === 1, "and the drop is counted");
ok(structured.every((c) => c.model === "gemini-3.5-flash-lite,gemini-3.1-flash-lite"), "every research call runs on Flash-Lite");
ok(structured.filter((c) => c.schemaName !== "dossier_plan_searches").every((c) => c.content.includes(ARTICLE)), "rate, pick and notes all carry the source articles whole");
ok(structured.some((c) => c.schemaName === "dossier_notes" && c.content.includes(WIKI)), "the notes call reads the whole document");
ok(structured.some((c) => c.schemaName === "dossier_rate_sources" && c.content.includes("### FRED") && !c.content.includes("### Health")), "every offered source is scored; a non-data source is not offered");

const noCatalogue = await researchPrincipals({
  llm,
  principals,
  headline,
  storyText,
  datagod,
  fetchImpl: (async () => new Response("", { status: 503 })) as typeof fetch,
});
ok(noCatalogue.length === 2 && noCatalogue.every((e) => e.research === "" && e.detail === null), "an unreadable catalogue keeps every principal, with no research");

const connections = await findConnections({ llm, storyText, dossier: entries });
ok(connections.length === 1 && connections[0].between.includes("Venezuela"), "a connection the articles already carry is dropped");
const hypotheses = await projectHypotheses({ llm, storyText, dossier: entries, connections });
ok(hypotheses.length === 1 && hypotheses[0].precedent.includes("Noriega"), "hypotheses come back grounded in a named precedent");
canned.story_hypotheses = { hypotheses: [] };
ok((await projectHypotheses({ llm, storyText, dossier: entries, connections })).length === 0, "an empty hypothesis list is an answer, not a throw");

const block = dossierRecord({ dossier: entries, connections, hypotheses });
ok(
  block.includes("THE DESK'S DOSSIER") && block.includes("outlived him") && block.includes("the oil is the leverage") && block.includes("Manuel Noriega, 1990"),
  "the block carries the research, the connections and the hypotheses",
);
ok(dossierRecord({ dossier: [], connections, hypotheses }) === "", "no principals → no block");

const persona = { name: "Test Writer", method: "m", priors: "p", voice: "v" } as PersonaProfile;
const shared = { llm, persona, storyHeadline: headline, evidenceBlock: ARTICLE, outletNames: ["Reuters", "AP"], parallel: null, echoes: [], wordCap: 1500, maxAttempts: 1 };
prompts.length = 0;
await composeAuthorVersion({ ...shared, dossier: block });
ok(prompts[0]?.includes("THE DESK'S DOSSIER") === true, "the column prompt carries the dossier block when one exists");
prompts.length = 0;
await composeAuthorVersion({ ...shared, dossier: "" });
ok(prompts[0]?.includes("THE DESK'S DOSSIER") === false, "and does not when there is none");

if (failed > 0) {
  console.log(`dossier checks: ${failed} FAILED`);
  process.exit(1);
}
console.log("dossier checks: all green");
