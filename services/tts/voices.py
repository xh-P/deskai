"""Read the supplied v2 registry without changing assets or training state."""
from __future__ import annotations

import json
from pathlib import Path
import re

VOICE_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,127}")


def is_voice_id(value) -> bool:
    return isinstance(value, str) and VOICE_ID.fullmatch(value) is not None


def contained_file(base: Path, relative: str) -> Path:
    path = (base / relative).resolve()
    if not path.is_relative_to(base.resolve()) or not path.is_file():
        raise ValueError("Missing resource or path outside the supplied asset directory")
    return path


def load_registry(root: Path, config: dict) -> dict[str, dict]:
    model_root = root / config["modelDirectory"]
    reference_root = root / config["referenceDirectory"]
    rows = json.loads(contained_file(model_root, config["registry"]).read_text(encoding="utf-8-sig"))
    voices = {}
    for row in rows:
        voice_id = config["voiceIds"][Path(row["gpt"]).as_posix()]
        if not is_voice_id(voice_id) or voice_id in voices:
            raise ValueError("Invalid or duplicate voice ID")
        refs = [{**ref, "id": f"ref-{index + 1:02d}", "path": contained_file(reference_root, ref["file"])}
                for index, ref in enumerate(row["refs"])]
        if not refs:
            raise ValueError("Voice has no reference audio")
        voices[voice_id] = dict(id=voice_id, name=row["name"], version="v2",
                                defaultReferenceId=refs[0]["id"],
                                gpt=contained_file(model_root, row["gpt"]),
                                sovits=contained_file(model_root, row["sovits"]), references=refs)
    if config["defaultVoiceId"] not in voices:
        raise ValueError("Default voice is missing from the registry")
    return voices


def public_registry(registry: dict[str, dict]) -> list[dict]:
    """Only opaque IDs/labels cross IPC; never accept model or audio paths."""
    return [dict(id=v["id"], name=v["name"], version=v["version"], defaultReferenceId=v["defaultReferenceId"],
                 references=[dict(id=r["id"], name=r["name"]) for r in v["references"]])
            for v in registry.values()]


def select_reference(voice: dict, reference_id=None) -> dict:
    reference_id = voice["defaultReferenceId"] if reference_id is None else reference_id
    for ref in voice["references"]:
        if ref["id"] == reference_id:
            return ref
    raise ValueError("Unknown reference ID")
