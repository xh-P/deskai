"""Fetch the pinned official GPT-SoVITS v5 Turbo assets, with resume + hashes."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "runtime/GPT-SoVITS/GPT_SoVITS/pretrained_models"
REVISION = "8f8857563c040d542de108a2c18b0425abd6c9c5"
FILES = [
    ("chinese-hubert-base/config.json", 1449, "git", "0bb839d4b0cd2ad41cb13c6500fd660800aaefdf"),
    ("chinese-hubert-base/preprocessor_config.json", 212, "git", "409547bbb99588f69a603019a707505610fa38d3"),
    ("chinese-hubert-base/pytorch_model.bin", 188811417, "sha256", "24164f129c66499d1346e2aa55f183250c223161ec2770c0da3d3b08cf432d3c"),
    ("chinese-roberta-wwm-ext-large/config.json", 963, "git", "3ae58d7f0734373bb28d3b6b9d6858b34f600b4a"),
    ("chinese-roberta-wwm-ext-large/tokenizer.json", 268962, "git", "9e77beb20869ea3b7850166fbc8cc7734662a017"),
    ("chinese-roberta-wwm-ext-large/pytorch_model.bin", 651225145, "sha256", "e53a693acc59ace251d143d068096ae0d7b79e4b1b503fa84c9dcf576448c1d8"),
    ("s1v3.ckpt", 155284856, "sha256", "87133414860ea14ff6620c483a3db5ed07b44be42e2c3fcdad65523a729a745a"),
    ("gsv-v5-pretrained/s2Gv5turbo.pth", 766406144, "sha256", "287b32a06b7d486f5303ec520468b0728fb01aac8b0f5d86fd5455c9a1d3e022"),
    ("gsv-v5-pretrained/vocoder.pth", 57761163, "sha256", "b7543c83222aa2105bb4efb56845086bc5f2eeba61243d723ffa062052b3221f"),
]


def matches(path: Path, size: int, kind: str, expected: str) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    h = hashlib.sha1() if kind == "git" else hashlib.sha256()
    if kind == "git":
        h.update(f"blob {size}\0".encode())
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest() == expected


def fetch(spec: tuple, origin: str) -> str:
    name, size, kind, digest = spec
    path = DEST / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if matches(path, size, kind, digest):
        print(f"VERIFIED {name}", flush=True)
        return name
    partial = path.with_name(path.name + ".part")
    url = f"{origin}/lj1995/GPT-SoVITS/resolve/{REVISION}/{name}"
    for attempt in range(1, 5):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            if offset >= size:
                if matches(partial, size, kind, digest):
                    partial.replace(path)
                    return name
                partial.unlink()
                offset = 0
            headers = {"Range": f"bytes={offset}-"} if offset else {}
            with requests.get(url, headers=headers, stream=True, timeout=(20, 90)) as r:
                r.raise_for_status()
                if r.status_code == 206:
                    if not r.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                        raise RuntimeError("unexpected Content-Range")
                else:
                    offset = 0
                last_report = time.monotonic()
                print(f"DOWNLOAD {name} {offset}/{size}", flush=True)
                with partial.open("ab" if offset else "wb") as out:
                    for chunk in r.iter_content(1024 * 1024):
                        if chunk:
                            out.write(chunk)
                            offset += len(chunk)
                        if time.monotonic() - last_report > 15:
                            print(f"PROGRESS {name}: {offset / size:.1%}", flush=True)
                            last_report = time.monotonic()
            if not matches(partial, size, kind, digest):
                raise RuntimeError(f"size/hash mismatch: {name}")
            partial.replace(path)
            print(f"VERIFIED {name}", flush=True)
            return name
        except Exception as exc:
            print(f"RETRY {name} {attempt}/4: {type(exc).__name__}: {exc}", flush=True)
            if attempt == 4:
                raise
            time.sleep(attempt * 2)
    raise AssertionError("unreachable")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", default="https://huggingface.co")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if args.origin not in ("https://huggingface.co", "https://hf-mirror.com"):
        parser.error("Use the official host or its hash-verified mirror.")
    if args.verify_only:
        missing = [name for name, size, kind, digest in FILES
                   if not matches(DEST / name, size, kind, digest)]
        if missing:
            raise SystemExit("Missing or invalid: " + ", ".join(missing))
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(lambda spec: fetch(spec, args.origin), FILES))
    manifest = ROOT / "training/nagato_disappearance_v5/models.manifest.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps({
        "repository": "lj1995/GPT-SoVITS", "revision": REVISION,
        "files": [dict(path=n, size=s, hash_type=k, hash=h) for n, s, k, h in FILES],
    }, indent=2), encoding="utf-8")
    print("All pinned v5 Turbo model assets verified.", flush=True)


if __name__ == "__main__":
    main()
