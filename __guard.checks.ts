/**
 * Domain-leak / purity AST guard for the blog engine CORE.
 * Run: npx tsx __guard.checks.ts
 *
 * Companion to the ESLint boundary override in eslint.config.mjs. This is a
 * portable check (no ESLint needed) that FAILS CI if the engine core
 * re-acquires either of:
 *
 *   1. a `process.env` read — the core must be env-free; the host adapter
 *      supplies config via `EngineConfig.knobs`. (`engine/clients/**` may read
 *      env for SDK API keys, so it is excluded.)
 *   2. an `owl-alpha` MODEL-ID LITERAL — a quoted string such as
 *      `"openrouter/owl-alpha"`. owl-alpha is an unstable alias that returns
 *      empty completions; the core must default to a stable model id supplied
 *      via knobs. The word `owl-alpha` legitimately appears in CODE COMMENTS
 *      (documenting the quirk) — the guard targets the string literal node,
 *      never the comment.
 *   3. a BRAND LITERAL — a quoted string (or template segment) containing the
 *      brand name (`Example News` / `example.com`). Brand text is externalized to
 *      `BrandProfile.name` and threaded as `${brand.name}`/`${brandName}`, so a
 *      hardcoded brand literal in the core would re-couple the engine to one
 *      outlet. The brand name legitimately appears in CODE COMMENTS (docstring
 *      examples) — the guard targets literal nodes, never comments.
 *
 * Why the TypeScript AST (not a hand-rolled comment stripper): comments are not
 * nodes in the AST, so they are structurally excluded — we only ever inspect
 * real `PropertyAccessExpression` / `StringLiteral` nodes. This eliminates the
 * whole class of tokenizer desync bugs (e.g. a regex literal carrying a lone
 * straight quote opening a phantom string-state that swallows a following
 * comment) that a manual scanner is prone to. `typescript` is already a project
 * dependency, so the guard stays dependency-light.
 *
 * Scope: the engine CORE only. `clients/**` (SDK adapters), `testing/**` (test
 * infra), `examples/**` (demo code), and `*.checks.ts` (these guards) are
 * excluded, as are vendored/build dirs (`node_modules`, `dist`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ENGINE_DIR = join(import.meta.dirname);

/** Directories that are NOT engine source and must never be scanned. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Recursively collect every `.ts` file under `dir` (skipping vendored/build dirs). */
const collectTs = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTs(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
};

/** Core = every engine `.ts` EXCEPT clients/, testing/, examples/, and *.checks.ts. */
const isCoreFile = (path: string): boolean => {
  const rel = path.slice(ENGINE_DIR.length + 1);
  if (
    rel.startsWith("clients/") ||
    rel.startsWith("testing/") ||
    rel.startsWith("examples/")
  ) {
    return false;
  }
  if (rel.endsWith(".checks.ts")) return false;
  return true;
};

/** Report a violation per file:line. */
type Violation = { file: string; line: number; text: string; rule: string };

/**
 * `true` when `node` is the `process.env` member-access expression itself —
 * the shared root of both `process.env.X` and `process.env["X"]`.
 */
const isProcessEnvExpression = (node: ts.Node): boolean => {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (node.name.text !== "env") return false;
  const obj = node.expression;
  return ts.isIdentifier(obj) && obj.text === "process";
};

/**
 * `true` when `node` reads off `process.env` — i.e. `process.env.X`
 * (`PropertyAccessExpression`) or `process.env["X"]` (`ElementAccessExpression`)
 * whose `.expression` is the `process.env` access. Matches the access, not a
 * text substring, so `// comment about process.env` is never a node and a
 * `myProcess.env` lookalike with a different root is correctly ignored.
 */
const isProcessEnvRead = (node: ts.Node): boolean => {
  if (ts.isPropertyAccessExpression(node)) {
    return isProcessEnvExpression(node.expression);
  }
  if (ts.isElementAccessExpression(node)) {
    return isProcessEnvExpression(node.expression);
  }
  return false;
};

/**
 * `true` when `node` is a quoted string (or no-substitution template) whose
 * literal text contains `owl-alpha` — i.e. a model-id literal. A comment
 * mentioning owl-alpha is not a node, so it never matches.
 */
const isOwlAlphaLiteral = (node: ts.Node): boolean => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.includes("owl-alpha");
  }
  return false;
};

/**
 * `true` when `node` is a string-bearing LITERAL whose text contains the brand
 * name (`example news` / `example.com`, case-insensitive — catches both the
 * "Example News" prose form and the "example.com" domain). Covers all three
 * literal carriers a hardcoded brand string could hide in:
 *   - `StringLiteral` / `NoSubstitutionTemplateLiteral` — a plain quote / a
 *     backtick string with no `${}`;
 *   - `TemplateHead`/`TemplateMiddle`/`TemplateTail` — the STATIC segments of a
 *     `${…}`-bearing template literal (the genericized prompts interpolate
 *     `${brand.name}`, so their surrounding text must carry NO brand literal).
 * A comment mentioning the brand is not a node, so it never matches.
 */
const isBrandLiteral = (node: ts.Node): boolean => {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    const lower = node.text.toLowerCase();
    return lower.includes("example news") || lower.includes("example.com");
  }
  return false;
};

const scan = (path: string): Violation[] => {
  const text = readFileSync(path, "utf8");
  const rel = path.slice(ENGINE_DIR.length + 1);
  const sourceFile = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const violations: Violation[] = [];

  const at = (node: ts.Node): { line: number; text: string } => {
    const start = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    return { line: line + 1, text: node.getText(sourceFile).trim() };
  };

  const visit = (node: ts.Node): void => {
    if (isProcessEnvRead(node)) {
      const { line, text: snippet } = at(node);
      violations.push({
        file: rel,
        line,
        text: snippet,
        rule: "process.env read (core must be env-free)",
      });
    }
    if (isOwlAlphaLiteral(node)) {
      const { line, text: snippet } = at(node);
      violations.push({
        file: rel,
        line,
        text: snippet,
        rule: "owl-alpha model-id literal (use a stable id from knobs)",
      });
    }
    if (isBrandLiteral(node)) {
      const { line, text: snippet } = at(node);
      violations.push({
        file: rel,
        line,
        text: snippet,
        rule: "brand literal (use ${brand.name}/${brandName} — externalized to BrandProfile.name)",
      });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return violations;
};

const coreFiles = collectTs(ENGINE_DIR).filter(isCoreFile).sort();
const allViolations = coreFiles.flatMap(scan);

process.stdout.write(`Scanned ${coreFiles.length} engine core files.\n`);

if (allViolations.length === 0) {
  process.stdout.write(
    "PASS engine core is env-free + no owl-alpha model-id literal + no brand literal\n",
  );
  process.stdout.write("\nALL passed\n");
} else {
  for (const v of allViolations) {
    process.stdout.write(
      `FAIL ${v.file}:${v.line}  [${v.rule}]\n      ${v.text}\n`,
    );
  }
  process.stdout.write(`\n${allViolations.length} VIOLATION(S)\n`);
  process.exit(1);
}
