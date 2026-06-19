/**
 * Phase 3 — Assemble + editor tie-together.
 *
 * assemble    — pure: stitch the per-section markdowns under the H1 title.
 * tieTogether — the existing two editor passes (runEdit line-edit → runFinalEdit
 *               managing-editor), which smooth transitions, kill cross-section
 *               repetition, and enforce one voice/arc. Mirrors the current
 *               runPipeline sequence (3605-3608) exactly, including the
 *               empty-article guard. These passes legitimately restructure
 *               (cut ~10%, merge duplicate sections), so they are intentionally
 *               NOT wrapped in lengthSafe — that ratio guard is for the surgical
 *               gate passes that follow, which must stay ~1:1.
 *
 * The two editor passes are INJECTED through `AssemblyDeps` (built by
 * generate.ts) so this module imports nothing back from generate.ts — no cycle.
 */
import { type Plan } from "./planning";

/**
 * The editor passes Phase 3 needs, injected by the orchestrator (generate.ts) so
 * this module stays off the `./generate` import graph. Each is generate.ts's own
 * function, unchanged.
 */
export interface AssemblyDeps {
  runEdit: (draft: string) => Promise<string>;
  runFinalEdit: (article: string) => Promise<string>;
}

/** Stitch section markdowns (each already starting at its own H2) under the H1. */
export function assemble(plan: Plan, sectionMarkdowns: string[]): string {
  return `# ${plan.title}\n\n${sectionMarkdowns.join("\n\n")}`;
}

/** Line-edit then managing-editor pass — ties the independently-written sections
 *  into one coherent piece before the gate chain. Throws if a pass empties it. */
export async function tieTogether(
  article: string,
  deps: AssemblyDeps,
): Promise<string> {
  const edited = await deps.runEdit(article);
  if (!edited.trim()) throw new Error("Editor pass produced an empty article");
  return deps.runFinalEdit(edited);
}
