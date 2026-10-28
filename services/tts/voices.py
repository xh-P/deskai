"""Read the supplied v2 registry without changing assets or training state."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODEL_ROOT = ROOT / "assets/凉宫春日模型包.part1"
REFERENCE_ROOT = ROOT / "assets/凉宫春日参考语音包"
DEFAULT_VOICE = "nagato-normal-v2"

VOICE_IDS = {
    "Haruhi": "haruhi-v2", "Kyon": "kyon-v2", "Itsuki": "koizumi-v2",
    "Nagato_Normal": DEFAULT_VOICE, "Nagato_Disappearance": "nagato-disappearance-v2",
    "Mikuru": "mikuru-v2", "OldMikuru": "mikuru-adult-v2",
    "KyonSister": "kyon-sister-v2", "Asakura": "asakura-v2", "Tsuruya": "tsuruya-v2",
}


def contained_file(base: Path, relative: str) -> Path:
    path = (base / relative).resolve()
    if not path.is_relative_to(base.resolve()) or not path.is_file():
        raise ValueError("Missing resource or path outside the supplied asset directory")
    return path


def load_registry() -> dict[str, dict]:
    rows = json.loads((MODEL_ROOT / "GPT_weights_v2/characters.json").read_text(encoding="utf-8-sig"))
    voices = {}
    for row in rows:
        stem = Path(row["gpt"]).stem.rsplit("_202", 1)[0]
        voice_id = VOICE_IDS[stem]
        if voice_id in voices:
            raise ValueError("Duplicate voice ID")
        refs = [{**ref, "path": contained_file(REFERENCE_ROOT, ref["file"])} for ref in row["refs"]]
        voices[voice_id] = dict(id=voice_id, name=row["name"], version="v2",
                                gpt=contained_file(MODEL_ROOT, row["gpt"]),
                                sovits=contained_file(MODEL_ROOT, row["sovits"]), references=refs)
    if len(voices) != 10 or DEFAULT_VOICE not in voices:
        raise ValueError("Expected ten supplied v2 voices including normal Nagato")
    return voices
