/** MLX embedder protocol — run: npx tsx clients/mlx-embedder.checks.ts */
import { EmbeddingUnavailable } from "../ports";
import { createMlxEmbedder } from "./mlx-embedder";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const vectors = (texts: string[]): { embeddings: number[][] } => ({
    embeddings: texts.map((t) => [t.length, 1, 2]),
  });

  {
    let calls = 0;
    const embedder = createMlxEmbedder({
      python: "/unused/python",
      runImpl: () => {
        calls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    ok("no process is started for an empty input list",
      (await embedder.embed([])).length === 0 && calls === 0, `calls=${calls}`);
  }

  {
    let sent = "";
    const embedder = createMlxEmbedder({
      python: "/venv/bin/python3",
      script: "/tmp/mlx_embed.py",
      model: "mlx-community/embeddinggemma-300m-4bit",
      runImpl: (req) => {
        sent = req.input;
        ok("the runner is the configured python and script",
          req.python === "/venv/bin/python3" && req.script.endsWith("mlx_embed.py"),
          JSON.stringify({ python: req.python, script: req.script }));
        ok("the model id is passed to the runner as MLX_EMBED_MODEL",
          req.env.MLX_EMBED_MODEL === "mlx-community/embeddinggemma-300m-4bit",
          JSON.stringify(req.env));
        const body = JSON.parse(req.input) as { texts: string[] };
        return { status: 0, stdout: JSON.stringify(vectors(body.texts)), stderr: "loading\n" };
      },
    });
    const out = await embedder.embed(["alpha", "beta"]);
    ok("stdin is a JSON object of the texts, in order",
      sent === JSON.stringify({ texts: ["alpha", "beta"] }), sent);
    ok("vectors come back in order, one per input",
      out.length === 2 && out[0][0] === 5 && out[1][0] === 4, JSON.stringify(out));
    ok("space names this checkpoint, not a Gemini model",
      embedder.space === "mlx-community/embeddinggemma-300m-4bit", String(embedder.space));
  }

  {
    const embedder = createMlxEmbedder({
      python: "/venv/bin/python3",
      runImpl: () => ({ status: 0, stdout: JSON.stringify({ embeddings: [[0.1]] }), stderr: "" }),
    });
    let mismatch = "";
    try {
      await embedder.embed(["a", "b"]);
    } catch (e: unknown) {
      mismatch = e instanceof Error ? e.message : String(e);
    }
    ok("a short vector list fails immediately, with a countable message",
      /returned 1 vectors for 2 inputs/.test(mismatch), `msg=${mismatch}`);
  }

  {
    const logs: string[] = [];
    const embedder = createMlxEmbedder({
      python: "/venv/bin/python3",
      log: (l) => logs.push(l),
      runImpl: () => ({
        status: 1,
        stdout: "",
        stderr: "ModuleNotFoundError: No module named 'mlx_embeddings'",
      }),
    });
    let threw: unknown;
    try {
      await embedder.embed(["a"]);
    } catch (e: unknown) {
      threw = e;
    }
    ok("a dead runner is EmbeddingUnavailable, not a Gemini quota error",
      threw instanceof EmbeddingUnavailable && String(threw).includes("mlx_embeddings"),
      String(threw));
    ok("the failure is logged rather than swallowed",
      logs.some((l) => l.includes("mlx-embedder")), JSON.stringify(logs));
  }

  {
    const embedder = createMlxEmbedder({
      python: "/venv/bin/python3",
      runImpl: () => ({
        status: 0,
        stdout: "UserWarning: something\n{\"embeddings\": [[1, 2]]}\n",
        stderr: "",
      }),
    });
    const out = await embedder.embed(["x"]);
    ok("library banners on stdout do not hide the JSON contract",
      out.length === 1 && out[0][0] === 1, JSON.stringify(out));
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("mlx-embedder checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`mlx-embedder.checks failed: ${String(err)}\n`);
  process.exit(1);
});
