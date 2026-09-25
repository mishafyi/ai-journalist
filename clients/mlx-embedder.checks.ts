/** MLX embedder protocol — run: npx tsx clients/mlx-embedder.checks.ts */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // The model loads once per process (~1.8 s on the mini): a 3,000-headline
    // index split 64 to a process spent ~85 s of every desk run loading it.
    let calls = 0;
    const embedder = createMlxEmbedder({
      python: "/venv/bin/python3",
      runImpl: (req) => {
        calls += 1;
        return { status: 0, stdout: JSON.stringify(vectors((JSON.parse(req.input) as { texts: string[] }).texts)), stderr: "" };
      },
    });
    const texts = Array.from({ length: 130 }, (_, i) => `headline ${i}`);
    const out = await embedder.embed(texts);
    ok("a whole index is embedded by ONE runner process",
      calls === 1 && out.length === 130 && out[129][0] === "headline 129".length, `calls=${calls} n=${out.length}`);
  }

  {
    // 3,028 headlines x 768 floats print ~49 MB of JSON; a reply over the pipe
    // buffer used to fail the run as EmbeddingUnavailable (ENOBUFS).
    const dir = mkdtempSync(join(tmpdir(), "mlx-embed-check-"));
    const script = join(dir, "big.sh");
    // 35,000,000 "1," (head -c counts the newline tr strips) + a closing 1: ~70 MB.
    writeFileSync(script, `printf '{"embeddings":[['\nyes 1, | head -c 105000000 | tr -d '\\n'\nprintf '1]]}\\n'\n`);
    let err = "";
    let dims = 0;
    try {
      const embedder = createMlxEmbedder({ python: "/bin/sh", script });
      dims = (await embedder.embed(["x"]))[0].length;
    } catch (e: unknown) {
      err = String(e).slice(0, 160);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    ok("a 70 MB reply from the runner is read whole", err === "" && dims === 35_000_001, err || `dims=${dims}`);
  }

  {
    // Live, where the venv exists (the mini): a headline's vector must not
    // depend on what shares its batch. mlx-embeddings 0.1.0 leaks padding into
    // quantized models (https://github.com/Blaizzy/mlx-embeddings/issues/72) —
    // alone vs beside a long text measured cos 0.967 before the runner stopped padding.
    const python = process.env.MLX_EMBED_PYTHON;
    if (python === undefined) {
      process.stdout.write("SKIP padding: MLX_EMBED_PYTHON is not set\n");
    } else {
      const embedder = createMlxEmbedder({ python });
      const short = "Judge orders White House to restore access for CNN, MS NOW and Politico";
      const long = `${short} as the Senate votes on the Iran war and Hurricane Polo nears Baja California while ${"markets fall again and ".repeat(12)}`;
      const [alone] = await embedder.embed([short]);
      const [beside] = await embedder.embed([short, long]);
      const cos = alone.reduce((s, x, i) => s + x * beside[i], 0);
      ok("a headline embeds the same alone and beside a longer one", cos > 0.9999, `cos=${cos.toFixed(5)}`);
    }
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
