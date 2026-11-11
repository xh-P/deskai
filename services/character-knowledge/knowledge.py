"""Local E5 encoder and per-character FAISS indexes for dialogue references."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

import faiss
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


def load_corpus(directory, character_id):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", character_id):
        raise ValueError("CHARACTER_ID_INVALID")
    content = (directory / f"{character_id}.json").read_bytes()
    corpus = json.loads(content)
    entries = corpus["entries"]
    retrieval = corpus["retrieval"]
    if corpus["characterId"] != character_id or not 1 <= len(entries) <= 10000:
        raise ValueError("KNOWLEDGE_CORPUS_INVALID")
    for entry in entries:
        fields = {key: value for key, value in entry.items() if key != "aliases"}
        aliases = entry.get("aliases", [])
        if set(fields) != {"id", "source", "locator", "text"} or any(
            not isinstance(value, str) or not value.strip() or len(value) > 1000 for value in fields.values()
        ) or not isinstance(aliases, list) or len(aliases) > 16 or any(
            not isinstance(alias, str) or not alias.strip() or len(alias) > 80 for alias in aliases
        ):
            raise ValueError("KNOWLEDGE_ENTRY_INVALID")
    if len({entry["id"] for entry in entries}) != len(entries):
        raise ValueError("KNOWLEDGE_ENTRY_DUPLICATE")
    if not isinstance(retrieval["topK"], int) or not 1 <= retrieval["topK"] <= 3 or not 0 <= retrieval["maxDistance"] <= 4:
        raise ValueError("KNOWLEDGE_RETRIEVAL_INVALID")
    return entries, retrieval, hashlib.sha256(content).hexdigest()


class Encoder:
    def __init__(self, directory):
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id("<pad>"), pad_token="<pad>")
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(os.cpu_count() or 1, 4)
        self.session = ort.InferenceSession(str(directory / "model.onnx"), options, providers=["CPUExecutionProvider"])
        self.inputs = {value.name for value in self.session.get_inputs()}

    def encode(self, texts, prefix):
        rows = self.tokenizer.encode_batch([prefix + text for text in texts])
        mask = np.array([row.attention_mask for row in rows], dtype=np.int64)
        fields = {"input_ids": np.array([row.ids for row in rows], dtype=np.int64),
                  "attention_mask": mask, "token_type_ids": np.zeros_like(mask)}
        hidden = self.session.run(["last_hidden_state"], {name: fields[name] for name in self.inputs})[0]
        pooled = (hidden * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1, keepdims=True)
        vectors = np.ascontiguousarray(pooled, dtype=np.float32)
        faiss.normalize_L2(vectors)
        return vectors


def build(source, cache):
    encoder = Encoder(cache / "model")
    for file in sorted(source.glob("*.json")):
        entries, _, digest = load_corpus(source, file.stem)
        passages = [" ".join([entry["text"], *entry.get("aliases", [])]) for entry in entries]
        dimensions = encoder.session.get_outputs()[0].shape[-1]
        index = faiss.IndexFlatL2(dimensions)
        for start in range(0, len(passages), 32):
            index.add(encoder.encode(passages[start:start + 32], "passage: "))
        output = cache / "indexes" / file.stem
        output.mkdir(parents=True, exist_ok=True)
        temporary = output / "index.faiss.tmp"
        faiss.write_index(index, str(temporary))
        index_hash = hashlib.sha256(temporary.read_bytes()).hexdigest()
        temporary.replace(output / "index.faiss")
        metadata = output / "index.json.tmp"
        metadata.write_text(json.dumps({"corpus": digest, "index": index_hash}), encoding="utf-8")
        metadata.replace(output / "index.json")
        print(f"{file.stem}: {index.ntotal} entries")


class Lookup:
    def __init__(self, source, cache):
        self.source = source
        self.cache = cache
        self.encoder = Encoder(cache / "model")
        self.indexes = {}

    def index(self, character_id):
        entries, retrieval, digest = load_corpus(self.source, character_id)
        loaded = self.indexes.get(character_id)
        if loaded and loaded[0] == digest:
            return entries, retrieval, loaded[1]
        directory = self.cache / "indexes" / character_id
        metadata = json.loads((directory / "index.json").read_text(encoding="utf-8"))
        data = (directory / "index.faiss").read_bytes()
        if metadata != {"corpus": digest, "index": hashlib.sha256(data).hexdigest()}:
            raise ValueError("KNOWLEDGE_INDEX_STALE")
        index = faiss.deserialize_index(np.frombuffer(data, dtype=np.uint8))
        self.indexes[character_id] = (digest, index)
        return entries, retrieval, index

    def search(self, request):
        started = time.perf_counter()
        entries, retrieval, index = self.index(request["characterId"])
        distances, indexes = index.search(self.encoder.encode([request["text"]], "query: "), min(retrieval["topK"], len(entries)))
        ranked = [(int(idx), float(distance)) for idx, distance in zip(indexes[0], distances[0]) if idx >= 0]
        hits = [{**{key: entries[idx][key] for key in ("id", "source", "locator", "text")}, "distance": round(distance, 4)}
                for idx, distance in ranked if distance <= retrieval["maxDistance"]]
        return {"hits": hits, "nearestDistance": round(ranked[0][1], 4) if ranked else None,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 1)}


def serve(source, cache):
    lookup = Lookup(source, cache)
    for line in sys.stdin:
        request = json.loads(line)
        try:
            reply = lookup.search(request)
        except (FileNotFoundError, ValueError, RuntimeError, KeyError) as error:
            reply = {"error": str(error) if str(error).startswith("KNOWLEDGE_") else "KNOWLEDGE_INDEX_UNAVAILABLE"}
        print(json.dumps({"id": request["id"], **reply}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("build", "serve"))
    parser.add_argument("source", type=Path)
    parser.add_argument("cache", type=Path)
    args = parser.parse_args()
    (build if args.mode == "build" else serve)(args.source, args.cache)


if __name__ == "__main__":
    main()
