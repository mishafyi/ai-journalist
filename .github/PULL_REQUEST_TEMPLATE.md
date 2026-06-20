## Summary

<!-- What does this change and why? Link any related issue. -->

## Tests run

<!-- Paste the commands you ran and their result. -->

- [ ] `npm test` (byte-lock + purity checks + offline example) — green
- [ ] `npm run build` (`tsc --noEmit`) — clean

## Purity respected

- [ ] No host imports added to the core (no `@/…`, ORM, or framework — ports only)
- [ ] No `process.env` reads in the core (config flows through `EngineConfig`)
- [ ] No hardcoded brand literals in the core (`${brand.name}` only)
- [ ] Any prompt change updates its matching `*.checks.ts` byte-lock
