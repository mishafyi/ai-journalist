/** Extractive six-box research digest (Blundell indexing): organize raw
 * research BY STORY-ASPECT, not by source. Extractive-only — verbatim spans +
 * URL + date — because downstream fact-guarding treats research as ground
 * truth; a paraphrased digest would launder model text into that ground truth.
 * Writers read digests; the guards always read the RAW corpus. */
import type { LlmClient } from "./ports";
import type { SectionWriterDeps } from "./section-writer";

export interface DigestDeps {
  llm: LlmClient;
  model: string;
  withRetry: SectionWriterDeps["withRetry"];
}

export async function buildDigest(
  raw: string,
  label: string,
  deps: DigestDeps,
): Promise<string> {
  const prompt = `Today is ${new Date().toISOString().slice(0, 10)}. Below is raw research for a story ("${label}"). Index it into the six boxes a reporter uses, as a markdown outline with EXACTLY these H2 headings: HISTORY, SCOPE, REASONS, IMPACTS, COUNTERMOVES, FUTURES.
Rules: every bullet is a VERBATIM span copied from the research (a figure, claim, or quote — never paraphrase, never merge two sources into one bullet), followed by " — " + its source URL and the source's publication date in parentheses, normalized to YYYY-MM-DD, when a date is stated or clearly inferable anywhere in that source's text (relative forms like "3 days ago" resolve against today's date given at the top; omit the parenthetical when no date is discernible — never guess from a bare year). Rank bullets inside each box by importance to the story. Drop navigation junk, boilerplate, and duplicates (keep the newest dated duplicate). A box with nothing real stays empty ("- (nothing found)").

RAW RESEARCH:
${raw}

=== YOUR TASK, RESTATED ===
Output ONLY the six-box markdown outline described at the top — verbatim bullets with URL + date, ranked, de-junked. No preamble, no commentary.`;
  return deps.withRetry(`digest: ${label}`, () =>
    deps.llm.complete({ prompt, model: deps.model, temperature: 0.1 }),
  );
}
