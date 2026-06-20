# Contributing to AI Journalist

Thanks for your interest in improving the engine. This is a **domain-agnostic**
article-generation engine behind hexagonal ports — the most important thing to
internalize before contributing is the **purity contract** that keeps it that
way (see [The purity contract](#the-purity-contract) below).

## Getting started

```bash
git clone https://github.com/mishafyi/ai-journalist.git
cd ai-journalist
npm install
npm test        # byte-lock + purity checks AND the offline end-to-end example
```

The engine is ESM TypeScript source (`"type": "module"`). It ships **uncompiled**
— there is no build step that emits `dist/`; consumers run it via `tsx` or their
own bundler. `npm run build` is a type-check only (`tsc --noEmit`).

Scripts you'll use:

| Script                 | What it does                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `npm test`             | `test:checks` then `test:example` — the full suite              |
| `npm run test:checks`  | the AST purity guard + every `*.checks.ts` byte-lock (tsx)      |
| `npm run test:example` | the offline end-to-end demo under vitest                        |
| `npm run build`        | type-check (`tsc --noEmit`)                                     |

CI runs `npm ci`, `npm run build`, and `npm test` on Node 20 and 22 — keep both
green.

## The purity contract

The engine **core** must stay decoupled from any host app. Three rules are
enforced mechanically by [`__guard.checks.ts`](./__guard.checks.ts) (an AST-based
guard that scans the core and fails CI on a violation):

1. **No host imports.** Core modules import only sibling engine modules — never
   `@/…`, an ORM, a web framework, or anything host-specific. Domain-specific
   behavior is injected through the ports in [`ports.ts`](./ports.ts).
2. **No `process.env` reads in the core.** Configuration arrives via
   `EngineConfig` (and its `knobs` bag), not the environment. Only
   `clients/**` (the SDK adapters) may read env — for API keys.
3. **No hardcoded brand literals.** Brand text is supplied via
   `BrandProfile.name` and threaded as `${brand.name}`. A literal like
   `Example News` / `example.com` in the core fails the guard. (`clients/**`,
   `testing/**`, `examples/**`, and `*.checks.ts` are exempt.)

If you genuinely need a new dependency the four public ports (`Source` / `Sink` /
`Linker` / `EngineConfig`) can't carry, route it through the `EngineInternals`
carrier (see `ports.ts`) — it must still be engine-pure.

## Prompt changes update the byte-locks

The LLM prompts are **byte-locked** by the `*.checks.ts` files so prompt drift is
caught in review. If you intentionally change a prompt, **update the matching
byte-lock in the same PR** — `npm run test:checks` will fail until the expected
string matches. The check failures print the exact expected vs. actual text, so
copy the new prompt into the check once you're sure the change is correct. Never
loosen a byte-lock just to make it pass; the lock is the point.

The `*.checks.ts` scripts are standalone `tsx` programs (NOT vitest), run by the
shell loop in `test:checks` and excluded from the vitest glob.

## Pull request expectations

- `npm test` is green (checks + example).
- `npm run build` type-checks.
- Prompt edits carry their updated byte-lock.
- Keep changes focused; the engine's value is its strict boundary — don't smuggle
  host-specific assumptions into the core.

Open an issue first for anything large or architectural so we can agree on the
shape before you invest the work.
