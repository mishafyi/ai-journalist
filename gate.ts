/** All publish-gate checks, as a recorded warning list. The pipeline no longer
 *  BLOCKS on these (operator decision 2026-06-15: always publish, review later)
 *  — they are persisted to telemetry for the review sweep. Pure. */
export function computeGateWarnings(
  artFlags: Record<string, unknown>,
  wordFloor: number,
): string[] {
  const w: string[] = [];
  if (artFlags.titleFormulaCollision === true)
    w.push("title collides with a published formula");
  if (artFlags.titleTruncated === true)
    w.push("title was mechanically cut at the 200-char bound");
  if (artFlags.unguarded === true)
    w.push("fact-guard failed twice — article is unguarded");
  if (artFlags.titleRelationshipUngrounded === true)
    w.push("title asserts an entity relationship with no ground-truth support");
  if (artFlags.titleQuoteUnverbatim === true)
    w.push("title quotes a span that is not verbatim in the body");
  if (artFlags.wordsBelowTarget === true)
    w.push(`draft under the ${wordFloor}-word warning floor`);
  if (artFlags.boardDataUsedInPrint === false)
    w.push("relevant first-party board data never cited in print");
  // C4 (theme recast): pre-built warning STRINGS — their text needs run data
  // (newest source date / age / window, the kill note) only the recast site
  // knows, so it records the full message and this pass relays it verbatim.
  if (typeof artFlags.staleStory === "string") w.push(artFlags.staleStory);
  if (typeof artFlags.themeKilled === "string") w.push(artFlags.themeKilled);
  return w;
}
