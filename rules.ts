/**
 * rules.ts — every rule the news desk gives a model lives in
 * rules/<step>.md, one short numbered list per step, read whole at
 * import (operator, 2026-09-19: rules "concise/precise/actionable and numbered
 * so easy to audit", visible "without copying all the time"). The prompt reads
 * the file, the docs link to it, and the site's plain-node scripts read the
 * same file. A missing file throws at import.
 */
import { readFileSync } from "node:fs";

export function readRules(step: string): string {
  return readFileSync(new URL(`./rules/${step}.md`, import.meta.url), "utf8").trim();
}
