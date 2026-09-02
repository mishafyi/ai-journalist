/** The people dossier: schemas, provenance stamping, the prompt block, and its
 *  place in the column prompt. Run: npx tsx presets/dossier.checks.ts */
import { NO_PARALLEL_PHRASE } from "../gates";
import type { LlmClient } from "../ports";
import type { PersonaProfile } from "../ports";
import { composeAuthorVersion, dossierBlock, findConnections, namePrincipals, projectHypotheses, researchPrincipals } from "./news-desk";

let failed = 0;
const ok = (cond: boolean, msg: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed += 1;
};

const canned: Record<string, unknown> = {
  story_principals: {
    principals: [
      { name: "Nicolás Maduro", kind: "person", role: "deposed president, detained in Brooklyn" },
      { name: "Venezuela", kind: "country", role: "the state he ran" },
    ],
  },
  story_connections: {
    connections: [{ between: ["Nicolás Maduro", "Venezuela"], claim: "He ran the state whose oil the deal now allocates.", basis: "background: Maduro" }],
  },
  story_hypotheses: { hypotheses: [{ scenario: "The trial date becomes the bargaining chip in the oil talks.", restsOn: "connection: Maduro–Venezuela" }] },
};
const prompts: string[] = [];
const column = `## The Photographs Were the Message, Not the Man\n\n${"word ".repeat(200)}Reuters and AP reported it. ${NO_PARALLEL_PHRASE}\n\n## What a Brooklyn Cell Cannot Contain\n\n${"word ".repeat(150)}`;
const llm: LlmClient = {
  async complete({ prompt }) {
    prompts.push(prompt);
    return column;
  },
  async completeStructured<T>({ schema, schemaName }: { schema: { parse(v: unknown): T }; schemaName: string }): Promise<T> {
    return schema.parse(canned[schemaName]);
  },
};

const headline = "Venezuela's Maduro shares first photos from US detention";
const evidence = "- Maduro released photos from the Metropolitan Detention Center in Brooklyn";

const principals = await namePrincipals({ llm, headline, evidence });
ok(principals.length === 2 && principals.some((p) => p.kind === "country"), "principals: people and countries both come through");

const bare = await researchPrincipals({ principals });
ok(bare.every((e) => e.source === "model" && e.background === ""), "no DataGod → every entry is stamped 'model' with nothing on file");

const withWiki = await researchPrincipals({
  principals,
  datagod: { async get(path) { return path.includes("Maduro") ? { extract: "Nicolás Maduro is a Venezuelan politician." } : {}; } },
});
ok(withWiki[0].source === "wikipedia" && withWiki[0].background.includes("Venezuelan politician"), "an encyclopedia answer is stamped 'wikipedia' and kept");
ok(withWiki[1].source === "model", "an empty answer leaves the entry on the model's own knowledge");

const connections = await findConnections({ llm, headline, evidence, dossier: withWiki });
const hypotheses = await projectHypotheses({ llm, headline, evidence, dossier: withWiki, connections });
ok(connections.length === 1 && hypotheses.length === 1, "connections and hypotheses come back typed");

const block = dossierBlock({ dossier: withWiki, connections, hypotheses });
ok(block.includes("THE DESK'S DOSSIER") && block.includes("oil the deal now allocates") && block.includes("bargaining chip"), "the block carries principals, connections and hypotheses");
ok(dossierBlock({ dossier: [], connections, hypotheses }) === "", "no principals → no block");

const persona = { name: "Test Writer", method: "m", priors: "p", voice: "v" } as PersonaProfile;
const shared = { llm, persona, storyHeadline: headline, evidenceBlock: evidence, outletNames: ["Reuters", "AP"], parallel: null, echoes: [], wordCap: 1500, maxAttempts: 1 };
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
