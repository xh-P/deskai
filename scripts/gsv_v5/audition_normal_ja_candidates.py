"""Add one same-reference Japanese audition for the existing normal Nagato candidates."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from normal_context import ROOT, activate, configure_common

common = configure_common()
from audition import synthesize

SOURCE_COMPARISON = ROOT / "outputs/nagato_normal_v5_bilingual_candidates/20261025-154215-bilingual-candidates/comparison.json"
TEXT = "少しだけ、話を聞かせて。私はここにいる。"


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_japanese_support() -> dict:
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS_Config
    from text.cleaner import clean_text

    if "all_ja" not in TTS_Config.v2_languages:
        raise RuntimeError("The pinned upstream TTS v2 language list does not contain all_ja.")
    phones, _, normalized = clean_text(TEXT, "ja", "v2")
    if not phones or not normalized:
        raise RuntimeError("The pinned upstream Japanese cleaner returned no phonemes.")
    return {"language_code": "all_ja", "supported_by_v2_language_list": True,
            "clean_text_language": "ja", "normalized_text": normalized, "phoneme_count": len(phones),
            "v5turbo_language_config": "uses the v2 language list for non-v1 versions"}


def validate_output(output: Path, job: dict) -> dict:
    import numpy as np
    import soundfile as sf

    checked = {}
    for model_name in job["models"]:
        result_path = output / f"{model_name}.results.json"
        results = json.loads(result_path.read_text(encoding="utf-8"))["samples"]
        if len(results) != 1:
            raise RuntimeError(f"Expected one Japanese sample for {model_name}, got {len(results)}")
        row = results[0]
        if row["text"] != TEXT or row["language"] != "all_ja":
            raise RuntimeError(f"Text/language mismatch for {model_name}")
        wav = Path(row["file"])
        audio, rate = sf.read(wav, dtype="float32")
        duration = len(audio) / rate if rate else 0
        peak = float(np.abs(audio).max()) if audio.size else 0.0
        if (audio.ndim != 1 or not np.isfinite(audio).all() or not np.count_nonzero(audio)
                or duration < 1.0 or peak >= 0.9999):
            raise RuntimeError(f"Invalid or clipped Japanese sample: {wav}")
        checked[wav.name] = {"valid": True, "sample_rate": rate,
                             "duration_seconds": round(duration, 3),
                             "peak_amplitude": round(peak, 6),
                             "rms": round(float(np.sqrt(np.mean(audio ** 2))), 6),
                             "samples_at_full_scale": int(np.sum(np.abs(audio) >= 0.9999)),
                             "sha256": sha(wav)}
    return checked


def main() -> None:
    activate()
    import os
    os.chdir(common.REPO)
    japanese_check = verify_japanese_support()
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--worker", choices=["v5_s2e4_gpte5", "v5_s2e6_gpte10", "v5_s2e8_gpte15", "v2_normal"])
    args = parser.parse_args()
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d-%H%M%S-ja-candidates")
    output = (args.output_dir or ROOT / "outputs/nagato_normal_v5_ja_candidates" / stamp).resolve()
    if args.worker:
        job = json.loads((output / "comparison.json").read_text(encoding="utf-8"))
        synthesize(args.worker, output, job)
        return

    source_job = json.loads(SOURCE_COMPARISON.read_text(encoding="utf-8"))
    source_reference = Path(source_job["reference"])
    if not source_reference.is_file() or sha(source_reference) != source_job["reference_sha256"]:
        raise RuntimeError("The shared normal-Nagato reference differs from the prior bilingual comparison.")
    output.mkdir(parents=True, exist_ok=True)
    if (output / "comparison.json").exists():
        raise FileExistsError("Choose a new output directory to preserve prior auditions.")
    reference_copy = output / "reference.wav"
    shutil.copy2(source_reference, reference_copy)
    job = dict(source_job)
    job.update(reference=str(reference_copy), reference_sha256=sha(reference_copy),
               texts=[{"id": "ja", "language": "all_ja", "text": TEXT}],
               japanese_language_code_verification=japanese_check,
               source_bilingual_comparison=str(SOURCE_COMPARISON),
               source_bilingual_comparison_sha256=sha(SOURCE_COMPARISON),
               same_four_models_as_bilingual_comparison=True,
               same_reference_same_seed_same_sampling_parameters=True,
               training_performed_by_this_script=False,
               output_note="Four direct Japanese WAV samples only; no merged files. This is an audition, not subjective quality validation.")
    job.pop("bilingual_play_files", None)
    job.pop("validated_samples", None)
    job.pop("run_completed", None)
    (output / "comparison.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")

    for model_name in job["models"]:
        print(f"Generating Japanese sample: {model_name}", flush=True)
        with (output / f"{model_name}.log").open("w", encoding="utf-8") as log:
            subprocess.run([str(common.ENV / "python.exe"), "-u", str(Path(__file__).resolve()),
                            "--worker", model_name, "--output-dir", str(output)],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)

    job["validated_samples"] = validate_output(output, job)
    job["run_completed"] = True
    (output / "comparison.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "audio_validation.json").write_text(
        json.dumps({"samples": job["validated_samples"],
                    "subjective_quality_assessment_performed": False}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"Completed four Japanese audition samples: {output}", flush=True)


if __name__ == "__main__":
    main()
