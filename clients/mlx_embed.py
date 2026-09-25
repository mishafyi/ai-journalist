#!/usr/bin/env python3
"""mlx_embed.py — EmbeddingGemma through mlx-embeddings, one shot.

Contract (same shape as tts_mlx.py): stdin is JSON ``{"texts": ["…"]}``,
stdout is JSON ``{"embeddings": [[…], …]}``, in input order. Library banners go
to stderr.

Follows the model card's load + forward path (not ``generate()`` — that
unpacks ``input_ids=`` and Gemma3's ``__call__`` takes ``inputs``):
https://huggingface.co/mlx-community/embeddinggemma-300m-4bit

Task prefix is STS (headline-to-headline cosine), from that card:
``task: sentence similarity | query: ``

A batch only ever holds texts of ONE token length, so nothing is padded.
mlx-embeddings 0.1.0 casts the padding mask to a quantized checkpoint's packed
uint32 weights, which turns -inf into 0: padding leaks into every shorter
text's vector, and a headline scored differently depending on what shared its
batch (cos 0.967 against itself). Upstream:
https://github.com/Blaizzy/mlx-embeddings/issues/72
"""
from __future__ import annotations

import json
import os
import sys

STDOUT = sys.stdout
sys.stdout = sys.stderr

import mlx.core as mx  # noqa: E402
from mlx_embeddings import load  # noqa: E402

MODEL = os.environ.get("MLX_EMBED_MODEL", "mlx-community/embeddinggemma-300m-4bit")
PREFIX = "task: sentence similarity | query: "
CHUNK = 64


def prefixed(text: str) -> str:
    return text if text.startswith("task:") else f"{PREFIX}{text}"


def main() -> None:
    payload = json.load(sys.stdin)
    texts = payload.get("texts")
    if not isinstance(texts, list):
        raise SystemExit("mlx_embed.py: stdin JSON must be {\"texts\": [\"…\"]}")
    model, tokenizer = load(MODEL)
    ids = tokenizer([prefixed(t if isinstance(t, str) else str(t)) for t in texts], truncation=True)["input_ids"]
    by_length: dict[int, list[int]] = {}
    for i, row in enumerate(ids):
        by_length.setdefault(len(row), []).append(i)
    out: list[list[float]] = [[] for _ in texts]
    for rows in by_length.values():
        for start in range(0, len(rows), CHUNK):
            part = rows[start : start + CHUNK]
            batch = mx.array([ids[i] for i in part])
            embeds = model(batch, mx.ones(batch.shape)).text_embeds
            mx.eval(embeds)
            for i, vector in zip(part, embeds.tolist()):
                out[i] = vector
    json.dump({"embeddings": out}, STDOUT, separators=(",", ":"))
    STDOUT.write("\n")


if __name__ == "__main__":
    main()
