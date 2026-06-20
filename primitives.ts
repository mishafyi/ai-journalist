/**
 * ai-journalist — pure, brand-free text primitives (no singletons, no clients,
 * no DB, no prompts). These are the anti-repetition adjudicators shared by the
 * discovery flow; they import NOTHING (the AST purity guard keeps the engine
 * free of host-app, ORM, and framework imports), so the engine and any host-side
 * orchestrator can share one implementation.
 */

// Ultra-generic capitalized words that don't identify an entity (sentence
// starters + sector nouns shared by half the corpus titles).
const GENERIC_PROPER = new Set(
  "the a an and or but why how what when where it its this these those new most more every all no not us u.s ai space tech defense robotics startup startups jobs hiring engineers engineer salary salaries company companies".split(
    " ",
  ),
);

/**
 * Entity/event-overlap duplicate check: a candidate that shares a NON-GENERIC
 * proper noun (the company) AND a money/round token with a covered title is
 * the same story regardless of wording. R6C4 shipped a second article on the
 * identical Impulse $500M round at trigram 0.336 — under the 0.37 lexical
 * gate — because the surface wording diverged.
 */
export function sharesEntityEvent(candidate: string, covered: string): boolean {
  const nouns = (s: string): Set<string> =>
    new Set(
      (s.match(/\b[A-Z][a-zA-Z']+\b/g) ?? [])
        .map((w) => w.toLowerCase().replace(/'s$/, ""))
        .filter((w) => !GENERIC_PROPER.has(w)),
    );
  const money = (s: string): Set<string> =>
    new Set(
      (s.match(/\$\d[\d,.]*\s*(?:million|billion|[mbk])\b/gi) ?? []).map((m) =>
        m.replace(/[\s,]/g, "").toLowerCase(),
      ),
    );
  const candNouns = nouns(candidate);
  const covNouns = nouns(covered);
  const sharedNoun = [...candNouns].some((n) => covNouns.has(n));
  if (!sharedNoun) return false;
  const candMoney = money(candidate);
  if (candMoney.size === 0) return false;
  return [...candMoney].some((m) => money(covered).has(m));
}

function trigramSet(s: string): Set<string> {
  const norm = ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
  const grams = new Set<string>();
  for (let i = 0; i < norm.length - 2; i++) grams.add(norm.slice(i, i + 3));
  return grams;
}

/**
 * Character-trigram Jaccard (Sørensen–Dice) similarity — the lexical
 * anti-repetition backstop. The soft LLM "avoid these" instruction misses close
 * paraphrases ("AI token compensation" vs "AI Tokens…Compensate Engineers" — same
 * story, different words); shared character trigrams catch what word-matching and
 * naive stemming can't.
 */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigramSet(a);
  const B = trigramSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
