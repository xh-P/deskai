"""Audit and snapshot the double-ASR consensus set for normal Nagato."""
from __future__ import annotations

import csv
import hashlib
import json
import zipfile
from pathlib import Path

from normal_context import PROJECT, ROOT, SOURCE

ANNOTATIONS = ROOT / "assets/Nagato_Normal_annotations"
ARCHIVE = ROOT / "assets/The Melancholy of Haruhi Suzumiya/Nagato_Normal_v2.zip"


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_identical(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != content:
            raise FileExistsError(f"Refusing to replace existing normal-Nagato input: {path}")
        return
    path.write_bytes(content)


def main() -> None:
    provenance = json.loads((ANNOTATIONS / "run_provenance.json").read_text(encoding="utf-8"))
    summary = json.loads((ANNOTATIONS / "summary.json").read_text(encoding="utf-8"))
    if provenance.get("status") != "machine_only_not_human_reviewed":
        raise ValueError("Unexpected annotation provenance; inspect before training.")
    archive_hash = sha_file(ARCHIVE)
    if archive_hash != provenance["source_sha256"] or archive_hash != summary["source_archive_sha256"]:
        raise ValueError("The source archive differs from the ASR provenance snapshot.")

    candidates = []
    for line_no, line in enumerate((ANNOTATIONS / "lexical_consensus_candidate.list").read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        fields = line.split("|", 3)
        if len(fields) != 4:
            raise ValueError(f"Malformed consensus row {line_no}")
        relative, speaker, language, text = fields
        name = relative.replace("\\", "/").rsplit("/", 1)[-1]
        if speaker != "Nagato_Normal" or language.lower() not in {"ja", "jp"} or not text.strip():
            raise ValueError(f"Invalid normal-Nagato transcript row {line_no}")
        source = SOURCE / name
        if not source.is_file():
            raise FileNotFoundError(source)
        candidates.append((name, source, text.strip()))
    if len(candidates) != summary["candidate_count"] or len({row[0] for row in candidates}) != len(candidates):
        raise ValueError("Consensus candidates do not match the annotation report or contain duplicates.")

    expected_audio = {row["file"]: row["sha256"] for row in summary["audio"]}
    if len(expected_audio) != summary["input_count"]:
        raise ValueError("Malformed full-source audio hash inventory.")
    with zipfile.ZipFile(ARCHIVE) as bundle:
        for name, expected_hash in expected_audio.items():
            actual_hash = sha_file(SOURCE / name)
            archive_member = f"Nagato_Normal_v2/{name}"
            if actual_hash != expected_hash or sha_bytes(bundle.read(archive_member)) != actual_hash:
                raise ValueError(f"Source audio differs from its archived/annotated version: {name}")

    all_audio = sorted(SOURCE.glob("*.wav"))
    if len(all_audio) != summary["input_count"] or set(expected_audio) != {p.name for p in all_audio}:
        raise ValueError("The extracted source set does not match the 59-file annotation inventory.")

    labels = "".join(f"{(SOURCE / name).as_posix()}|nagato_normal_v5turbo|JA|{text}\n"
                     for name, _, text in candidates).encode("utf-8")
    write_identical(PROJECT / "labels.list", labels)

    candidate_names = {row[0] for row in candidates}
    annotation_snapshot = {
        "status": "machine_consensus_only_not_human_reviewed",
        "source_archive": str(ARCHIVE),
        "source_archive_sha256": archive_hash,
        "source_directory": str(SOURCE),
        "source_audio_count": len(all_audio),
        "candidate_count": len(candidates),
        "candidate_seconds": round(summary["candidate_seconds"], 3),
        "candidate_rule": summary["candidate_filter"],
        "draft_rule": summary["draft_selection"],
        "not_selected_count": len(expected_audio) - len(candidate_names),
        "labels_sha256": sha_bytes(labels),
        "audio": [dict(file=name, sha256=sha_file(path), transcript=text,
                        selection="double-ASR lexical consensus; still requires listening review")
                  for name, path, text in candidates],
        "excluded_audio": [{"file": name, "sha256": digest, "reason": "Not in the double-ASR consensus candidate list; retained for review."}
                           for name, digest in sorted(expected_audio.items()) if name not in candidate_names],
    }
    write_identical(PROJECT / "inputs/annotation_selection.json",
                     (json.dumps(annotation_snapshot, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

    # Retain compact source review artifacts beside the split and prepared-audio manifest.
    for filename in ("lexical_consensus_candidate.list", "clean_short_candidate.list", "review_queue.tsv", "comparison.tsv", "README_中文.txt"):
        write_identical(PROJECT / "inputs/annotations" / filename, (ANNOTATIONS / filename).read_bytes())
    print(json.dumps({"source_audio": len(all_audio), "selected_consensus": len(candidates),
                      "candidate_minutes": round(summary["candidate_seconds"] / 60, 2),
                      "excluded_for_review": annotation_snapshot["not_selected_count"],
                      "labels_sha256": annotation_snapshot["labels_sha256"],
                      "project": str(PROJECT)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
