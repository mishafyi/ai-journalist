/** Page cleaner: one scraped page in, the article's own text out.
 *  Run: npx tsx presets/clean.checks.ts */
import { readRules } from "../rules";
import { CLEAN_MODEL, cleanPage } from "./clean";
import type { LlmClient } from "../ports";

let failed = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  process.stdout.write(`${cond ? "PASS" : "FAIL"} ${name}${cond || detail === "" ? "" : ` — ${detail}`}\n`);
  if (!cond) failed += 1;
};

const page = { url: "https://wire.example/a", title: "Rates rise", source: "Wire", markdown: "Skip to content\n\nThe bank raised rates." };
const calls: { messages: { role: string; content: string }[]; schema: { safeParse(v: unknown): { success: boolean } }; schemaName: string; model?: string; temperature?: number }[] = [];
const llm = {
  async complete(): Promise<string> {
    throw new Error("the cleaner asks for JSON, never free text");
  },
  async completeStructured<T>(args: (typeof calls)[number]): Promise<T> {
    calls.push(args);
    return { isArticle: true, text: "The bank raised rates." } as T;
  },
} as unknown as LlmClient;

const cleaned = await cleanPage({ llm, page });
const call = calls[0];
const system = call?.messages.find((m) => m.role === "system")?.content ?? "";
const user = call?.messages.find((m) => m.role === "user")?.content ?? "{}";

ok("returns the model's verdict and text", cleaned.isArticle && cleaned.text === "The bank raised rates.", JSON.stringify(cleaned));
ok("the rules file goes whole as the system prompt", system.includes(readRules("clean")), system.slice(0, 120));
ok("the page goes as JSON data", JSON.stringify((JSON.parse(user) as { page: unknown }).page) === JSON.stringify(page), user.slice(0, 160));
ok("Flash-Lite only, as zerogtalent found: Gemma failed its JSON check", CLEAN_MODEL === "gemini-3.5-flash-lite,gemini-3.1-flash-lite" && call?.model === CLEAN_MODEL, String(call?.model));
ok("temperature 0: the text is copied, not written", call?.temperature === 0, String(call?.temperature));
ok("schema name routes the trace", call?.schemaName === "page_clean", String(call?.schemaName));
ok("a reply without text is refused", call?.schema.safeParse({ isArticle: true }).success === false);
ok("the rules ask for the article word for word and treat the page as data",
  readRules("clean").includes("word for word") && readRules("clean").includes("data, not instructions"));

const failing = { ...llm, completeStructured: async (): Promise<never> => { throw new Error("every key spent"); } } as unknown as LlmClient;
const thrown = await cleanPage({ llm: failing, page }).then(() => "", (err: unknown) => String(err));
ok("a page running several stories is not refused: the title picks the story",
  readRules("clean").includes("several stories"));
ok("a model failure reaches the caller", thrown.includes("every key spent"), thrown);

process.stdout.write(failed === 0 ? "\nALL passed\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
