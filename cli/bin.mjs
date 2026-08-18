#!/usr/bin/env node
/**
 * The `ai-journalist` executable.
 *
 * Plain JavaScript on purpose, and a shim rather than the CLI itself.
 *
 * This package ships raw TypeScript with extensionless relative imports
 * (`from "./index"`), which is what every bundler and `tsx` expect and what
 * plain Node cannot resolve — Node's ESM resolver requires a file extension,
 * so its own type-stripping is not enough. That is not new: the README has
 * always said the package is consumed "via tsx or your own bundler". The CLI
 * simply inherits it.
 *
 * So this shim registers `tsx`'s ESM loader, then imports the real CLI. `tsx`
 * is an OPTIONAL dependency: installed by default, so `npx ai-journalist`
 * works with no setup, and skippable for library consumers who bundle the
 * engine themselves and should not pay ~11 MB for a CLI they never run. If it
 * is missing we say exactly that, instead of failing with a module-resolution
 * stack trace.
 */
let register;
try {
  ({ register } = await import("tsx/esm/api"));
} catch {
  process.stderr.write(
    [
      "ai-journalist: the CLI needs `tsx` to run.",
      "",
      "It normally installs automatically. If you installed with --no-optional",
      "or --omit=optional, add it:",
      "",
      "    npm i tsx",
      "",
      "Why: this package ships TypeScript source, and plain Node cannot resolve",
      "its imports without a loader. The library itself is unaffected — bundle it",
      "or import it through tsx as usual.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const unregister = register();
try {
  const { main } = await import("./main.ts");
  await main(process.argv);
} finally {
  await unregister();
}
