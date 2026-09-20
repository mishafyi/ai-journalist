#!/usr/bin/env python3
"""mlx_embed.py — EmbeddingGemma through mlx-embeddings, one shot.

Contract (same shape as tts_mlx.py): stdin is JSON ``{"texts": ["…"]}``,
stdout is JSON ``{"embeddings": [[…], …]}``. Library banners go to stderr.

Follows the model card's load + forward path (not ``generate()`` — that
unpacks ``input_ids=`` and Gemma3's ``__call__`` takes ``inputs``):
https://huggingface.co/mlx-community/embeddinggemma-300m-4bit

Task prefix is STS (headline-to-headline cosine), from that card:
``task: sentence similarity | query: ``
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
    out: list[list[float]] = []
    for i in range(0, len(texts), CHUNK):
        chunk = [prefixed(t) if isinstance(t, str) else prefixed(str(t)) for t in texts[i : i + CHUNK]]
        encoded = tokenizer(chunk, padding=True, truncation=True, return_tensors="mlx")
        output = model(encoded["input_ids"], encoded["attention_mask"])
        embeds = output.text_embeds
        mx.eval(embeds)
        out.extend(embeds.tolist())
    json.dump({"embeddings": out}, STDOUT, separators=(",", ":"))
    STDOUT.write("\n")


if __name__ == "__main__":
    main()
