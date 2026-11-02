/** One scraped page cut down to its article: Firecrawl's main-content Markdown
 *  still carries menus, promos and related stories every later model would read. */
import { z } from "zod";
import { readRules } from "../rules";
import type { LlmClient } from "../ports";

/** Flash-Lite only: Gemma 4 31B failed this job's JSON check on zerogtalent's blog. */
export const CLEAN_MODEL = "gemini-3.5-flash-lite,gemini-3.1-flash-lite";
export const CLEAN_RULES = readRules("clean");

const CleanedSchema = z.object({
  isArticle: z.boolean(),
  text: z.string(),
});
export type CleanedPage = z.infer<typeof CleanedSchema>;

export async function cleanPage(args: {
  llm: LlmClient;
  page: { url: string; title: string; source: string; markdown: string };
}): Promise<CleanedPage> {
  return args.llm.completeStructured({
    messages: [
      { role: "system", content: `You cut a scraped news page down to its article.\n\nRULES:\n${CLEAN_RULES}` },
      { role: "user", content: JSON.stringify({ page: args.page }) },
    ],
    schema: CleanedSchema,
    schemaName: "page_clean",
    model: CLEAN_MODEL,
    temperature: 0,
  });
}
