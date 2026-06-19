/** Checks for run-context.ts. Run: npx tsx run-context.checks.ts */
import { createRunContext } from "./run-context";
let f = 0,
  p = 0;
const ok = (n: string, c: boolean): void => {
  if (c) {
    p++;
  } else {
    f++;
  }
  process.stdout.write(`${c ? "PASS" : "FAIL"} ${n}\n`);
};

const ctx = createRunContext("run_test_123");
ok("seeds runId", ctx.runId === "run_test_123");
ok("telemetry defaults to topic mode", ctx.telemetry.mode === "topic");
ok("telemetry starts with empty llmCalls", ctx.telemetry.llmCalls.length === 0);
ok("telemetry starts with empty retries", ctx.telemetry.retries.length === 0);
ok("runArtifacts starts empty", ctx.runArtifacts.length === 0);

ctx.recordArtifact("stage-a", "in", "out", { promptTokens: 5, ms: 10 });
ctx.recordArtifact("stage-b", null, "out2");
ok("recordArtifact appends in order", ctx.runArtifacts.length === 2);
ok(
  "recordArtifact assigns seq 0,1",
  ctx.runArtifacts[0].seq === 0 && ctx.runArtifacts[1].seq === 1,
);
ok(
  "recordArtifact carries stat + null-fills missing",
  ctx.runArtifacts[0].promptTokens === 5 &&
    ctx.runArtifacts[0].completionTokens === null &&
    ctx.runArtifacts[0].ms === 10 &&
    ctx.runArtifacts[1].input === null &&
    ctx.runArtifacts[1].promptTokens === null,
);

ctx.recordLlmCall({
  label: "title",
  attempts: 1,
  ms: 100,
  promptTokens: 50,
  completionTokens: 20,
});
ok("recordLlmCall appends", ctx.telemetry.llmCalls.length === 1);
ok(
  "recordLlmCall preserves fields",
  ctx.telemetry.llmCalls[0].label === "title",
);

ctx.recordRetry({ label: "draft", attempt: 2, error: "boom", body: "{}" });
ok("recordRetry appends", ctx.telemetry.retries.length === 1);
ok("recordRetry preserves body", ctx.telemetry.retries[0].body === "{}");

// telemetry field writes go through the shared mutable record
ctx.telemetry.article = { unguarded: true };
ctx.telemetry.discovery = { seeds: 3 };
ok("telemetry.article writable", ctx.telemetry.article?.unguarded === true);
ok("telemetry.discovery writable", ctx.telemetry.discovery?.seeds === 3);

// a second context is fully independent (scheduler reuse)
const ctx2 = createRunContext("run_other");
ok("fresh context isolated runId", ctx2.runId === "run_other");
ok("fresh context isolated artifacts", ctx2.runArtifacts.length === 0);
ok(
  "fresh context seq restarts at 0",
  (ctx2.recordArtifact("x", null, "y"), ctx2.runArtifacts[0].seq === 0),
);

process.stdout.write(`\n${p} passed, ${f} failed\n`);
if (f > 0) process.exit(1);
