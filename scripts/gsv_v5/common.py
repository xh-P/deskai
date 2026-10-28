from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT / "runtime/GPT-SoVITS"
ENV = ROOT / ".conda/gsv-v5"
PROJECT = ROOT / "training/nagato_disappearance_v5"
SOURCE = ROOT / "assets/The Melancholy of Haruhi Suzumiya/Nagato_Disappearance_v2"
PRETRAINED = REPO / "GPT_SoVITS/pretrained_models"
VERSION = "v5turbo"
EXPERIMENT = "nagato_disappearance_v5turbo"


def activate() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    PROJECT.mkdir(parents=True, exist_ok=True)
    paths = [REPO, REPO / "GPT_SoVITS", REPO / "GPT_SoVITS/BigVGAN"]
    os.environ["PYTHONPATH"] = os.pathsep.join(str(p) for p in paths)
    for p in reversed(paths):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))
    dll_paths = [ROOT / "runtime/ffmpeg/bin", ENV, ENV / "Scripts", ENV / "Library/bin", ENV / "Lib/site-packages/torch/lib"]
    os.environ["PATH"] = os.pathsep.join(str(p) for p in dll_paths) + os.pathsep + os.environ.get("PATH", "")
    settings = {
        "version": VERSION, "hz": "25hz", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1", "CUDA_VISIBLE_DEVICES": "0", "_CUDA_VISIBLE_DEVICES": "0",
        "OMP_NUM_THREADS": "4", "TOKENIZERS_PARALLELISM": "false", "GRADIO_ANALYTICS_ENABLED": "False",
        "HF_HOME": str(ROOT / ".cache/huggingface"), "TORCH_HOME": str(ROOT / ".cache/torch"),
        "NLTK_DATA": str(ROOT / ".cache/nltk_data"), "G2PW": "0",
        "GSV_EXPERIMENT": EXPERIMENT, "GSV_LABELS": str(PROJECT / "labels.list"),
        "GSV_WAV_DIR": str(SOURCE), "GSV_S1_BATCH": "1", "GSV_S2_BATCH": "1",
        "GSV_LORA_RANK": "16", "GSV_GRAD_CKPT": "1", "GSV_BIND": "127.0.0.1",
    }
    for k, v in settings.items():
        os.environ[k] = v


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)
