/**
 * cli/main.ts — the `ai-journalist` command.
 *
 * Three commands, in the order someone new hits them:
 *
 *   init    an interactive wizard: pick a model and a search backend from what
 *           is actually configured, write .env + signal.json, so the next step
 *           is a single command rather than a documentation hunt
 *   check   validate a signal file and say what is wrong with it — a fast,
 *           free, key-free way to confirm your data is shaped right before
 *           spending a model call on it
 *   write   run the pipeline over your data and save the article
 *
 * Everything real lives in `writeArticle`; this layer only parses arguments,
 * asks questions, and prints. That split is deliberate — anything a person can
 * do here, a program can do by importing the library, with no CLI in the way.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import { config as loadEnv } from "dotenv";
import { writeArticle } from "../write-article";
import { parseSignal } from "../schemas";
import {
  availableLlmProviders,
  availableSearchProviders,
  llmFromEnv,
  searchFromEnv,
  LLM_SETUP_HELP,
  SEARCH_SETUP_HELP,
  type LlmProvider,
  type SearchProvider,
} from "../clients/auto";

/** Every provider the wizard can offer, with what each one costs the user. */
const LLM_CHOICES: Array<{ value: LlmProvider; label: string; hint: string; env: string }> = [
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "hundreds of models, paid — get a key at openrouter.ai/keys",
    env: "OPENROUTER_API_KEY",
  },
  {
    value: "ollama",
    label: "Ollama (local)",
    hint: "free, runs on your machine — install from ollama.com",
    env: "OLLAMA_BASE_URL",
  },
];

const SEARCH_CHOICES: Array<{ value: SearchProvider; label: string; hint: string; env: string }> = [
  {
    value: "firecrawl",
    label: "Firecrawl",
    hint: "cloud (paid) or self-hosted — firecrawl.dev",
    env: "FIRECRAWL_API_KEY",
  },
  {
    value: "searxng",
    label: "SearXNG (self-hosted)",
    hint: "free, you run the index — github.com/searxng/searxng",
    env: "SEARXNG_URL",
  },
];

/** A starter signal, so `init` leaves behind something that actually runs. */
const EXAMPLE_SIGNAL = {
  framing: "what happened in my space this week",
  items: [
    {
      title: "Replace this with something that happened",
      summary:
        "One or two sentences of context. This is what the engine reasons over when it decides which story to tell, so write it the way you would brief a colleague.",
      entities: ["A company", "A person"],
      date: new Date().toISOString().slice(0, 10),
      url: "https://example.com/the-source",
    },
  ],
};

function cancelled(value: unknown): boolean {
  return p.isCancel(value);
}

/** `init` — ask what is available, write .env and signal.json. */
async function runInit(): Promise<void> {
  p.intro("ai-journalist — setup");

  const llmChoice = await p.select({
    message: "Which model should write the articles?",
    options: LLM_CHOICES.map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
  });
  if (cancelled(llmChoice)) return p.cancel("Setup cancelled.");

  const searchChoice = await p.select({
    message: "Which backend should it research with?",
    options: SEARCH_CHOICES.map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
  });
  if (cancelled(searchChoice)) return p.cancel("Setup cancelled.");

  const llmMeta = LLM_CHOICES.find((c) => c.value === llmChoice)!;
  const searchMeta = SEARCH_CHOICES.find((c) => c.value === searchChoice)!;

  const llmValue = await p.text({
    message: `${llmMeta.env}`,
    placeholder:
      llmChoice === "ollama" ? "http://localhost:11434" : "paste your key",
    defaultValue: llmChoice === "ollama" ? "http://localhost:11434" : "",
  });
  if (cancelled(llmValue)) return p.cancel("Setup cancelled.");

  const searchValue = await p.text({
    message: `${searchMeta.env}`,
    placeholder:
      searchChoice === "searxng" ? "http://localhost:8888" : "paste your key",
    defaultValue: searchChoice === "searxng" ? "http://localhost:8888" : "",
  });
  if (cancelled(searchValue)) return p.cancel("Setup cancelled.");

  const brandName = await p.text({
    message: "What is your publication called?",
    placeholder: "My Outlet",
    defaultValue: "My Outlet",
  });
  if (cancelled(brandName)) return p.cancel("Setup cancelled.");

  const beat = await p.text({
    message: "What does it cover?",
    placeholder: "climate tech",
    defaultValue: "climate tech",
  });
  if (cancelled(beat)) return p.cancel("Setup cancelled.");

  const envLines = [
    `${llmMeta.env}=${String(llmValue)}`,
    `${searchMeta.env}=${String(searchValue)}`,
    `AI_JOURNALIST_BRAND=${String(brandName)}`,
    `AI_JOURNALIST_BEAT=${String(beat)}`,
    "",
  ].join("\n");

  const writes: string[] = [];
  if (existsSync(".env")) {
    const append = await p.confirm({
      message: ".env already exists — append these settings to it?",
    });
    if (cancelled(append)) return p.cancel("Setup cancelled.");
    if (append) {
      const existing = await readFile(".env", "utf8");
      await writeFile(".env", `${existing.replace(/\n*$/, "\n")}\n${envLines}`);
      writes.push(".env (appended)");
    }
  } else {
    await writeFile(".env", envLines);
    writes.push(".env");
  }

  if (!existsSync("signal.json")) {
    await writeFile("signal.json", `${JSON.stringify(EXAMPLE_SIGNAL, null, 2)}\n`);
    writes.push("signal.json");
  }

  p.note(
    [
      writes.length ? `Wrote ${writes.join(" and ")}.` : "Nothing written.",
      "",
      "Next:",
      "  1. put your own items in signal.json",
      "  2. npx ai-journalist check signal.json",
      "  3. npx ai-journalist write signal.json",
    ].join("\n"),
    "Setup complete",
  );
  p.outro("Ready.");
}

/**
 * Turn a Zod failure into lines that name the field and the problem.
 *
 * The raw error is a JSON dump of issue objects — accurate and unreadable when
 * what you need is "item 0 is missing summary".
 */
function describeIssues(err: unknown): string[] {
  const message = err instanceof Error ? err.message : String(err);
  let issues: unknown;
  try {
    issues = JSON.parse(message);
  } catch {
    return [message];
  }
  if (!Array.isArray(issues)) return [message];

  return issues.map((raw) => {
    const issue = raw as { path?: unknown[]; message?: string; expected?: string };
    const path = Array.isArray(issue.path) && issue.path.length
      ? issue.path.map((p) => (typeof p === "number" ? `item ${p}` : String(p))).join(" → ")
      : "(root)";
    const detail = issue.message ?? (issue.expected ? `expected ${issue.expected}` : "invalid");
    return `${path}: ${detail}`;
  });
}

/** `check` — validate a signal file without spending a model call. */
async function runCheck(file: string): Promise<void> {
  const path = resolve(file);
  if (!existsSync(path)) {
    process.stderr.write(`No such file: ${file}\n`);
    process.exitCode = 1;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    process.stderr.write(
      `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    const signal = parseSignal(parsed);
    const withUrl = signal.items.filter((i) => i.url).length;
    const withDate = signal.items.filter((i) => i.date).length;
    process.stdout.write(
      [
        `${file} is valid.`,
        `  ${signal.items.length} item(s)` +
          (signal.framing ? `, framing: "${signal.framing}"` : ", no framing"),
        `  ${withUrl} with a url, ${withDate} with a date`,
        withUrl < signal.items.length
          ? "  note: items without a url are harder for the engine to attribute."
          : "",
        "",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (err) {
    process.stderr.write(`${file} is not a valid signal.\n`);
    for (const line of describeIssues(err)) process.stderr.write(`  ${line}\n`);
    process.stderr.write(
      "\nEach item needs at least: title (string), summary (string), entities (string[]).\n",
    );
    process.exitCode = 1;
  }
}

interface WriteFlags {
  out: string;
  brand?: string;
  beat?: string;
  topic?: string;
  model?: string;
  llm?: LlmProvider;
  search?: SearchProvider;
}

/** `write` — the actual run. */
async function runWrite(from: string, flags: WriteFlags): Promise<void> {
  // `quiet` suppresses dotenv v17's "injected env … // tip:" banner, which
  // otherwise prints promotional text above every run's output.
  loadEnv({ quiet: true });

  const brandName = flags.brand ?? process.env.AI_JOURNALIST_BRAND;
  const beat = flags.beat ?? process.env.AI_JOURNALIST_BEAT;
  if (!brandName || !beat) {
    process.stderr.write(
      [
        "Missing publication details.",
        "",
        "  --brand \"My Outlet\" --beat \"climate tech\"",
        "",
        "or set AI_JOURNALIST_BRAND / AI_JOURNALIST_BEAT (npx ai-journalist init writes them).",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  // Resolve providers BEFORE any work, so a missing key fails in a second
  // rather than after a discovery pass.
  let llm, search;
  try {
    llm = llmFromEnv(flags.llm);
    search = searchFromEnv(flags.search);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write("Run `npx ai-journalist init` to set this up interactively.\n");
    process.exitCode = 1;
    return;
  }

  const spinner = p.spinner();
  spinner.start(
    `Writing with ${llm.provider} (${llm.via}) + ${search.provider} (${search.via})`,
  );

  try {
    const article = await writeArticle({
      from,
      brand: { name: brandName, beat },
      llm: llm.client,
      search: search.client,
      topic: flags.topic,
      model: flags.model,
    });

    const outPath = resolve(flags.out, `${article.slug}.md`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, article.markdown);

    spinner.stop(`Wrote ${outPath}`);
    process.stdout.write(`\n  ${article.title}\n  ${article.markdown.length} characters\n\n`);
  } catch (err) {
    spinner.stop("Failed");
    // The engine throws on purpose when an article cannot meet its contract —
    // surface that reason rather than a stack trace.
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exitCode = 1;
  }
}

/** Build the command tree. Exported so tests can inspect it without running. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("ai-journalist")
    .description(
      "Turn your data into a researched, fact-checked article.\n" +
        "Point it at a JSON file, a feed, or an API and it writes the story.",
    )
    .version("0.8.2");

  program
    .command("init")
    .description("set up a model, a search backend, and an example signal file")
    .action(runInit);

  program
    .command("check")
    .argument("<file>", "signal JSON file to validate")
    .description("check your data is shaped right — no API calls, no cost")
    .action(runCheck);

  program
    .command("write")
    .argument(
      "<from>",
      "your data: a .json file, an http(s) URL, or a feed URL",
    )
    .option("-o, --out <dir>", "where to save the article", "articles")
    .option("--brand <name>", "publication name")
    .option("--beat <beat>", "what it covers, e.g. \"climate tech\"")
    .option("--topic <topic>", "write this story instead of discovering one")
    .option("--model <id>", "pin a specific model id")
    .option("--llm <provider>", "openrouter | ollama")
    .option("--search <provider>", "firecrawl | searxng")
    .description("write an article from your data")
    .action(runWrite);

  return program;
}

/** Entry point used by cli/bin.mjs. */
export async function main(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

/** What `init` would offer given the current environment — used by the checks. */
export function configuredProviders(env: NodeJS.ProcessEnv = process.env): {
  llm: LlmProvider[];
  search: SearchProvider[];
  ready: boolean;
} {
  const llm = availableLlmProviders(env);
  const search = availableSearchProviders(env);
  return { llm, search, ready: llm.length > 0 && search.length > 0 };
}

export { LLM_SETUP_HELP, SEARCH_SETUP_HELP };
