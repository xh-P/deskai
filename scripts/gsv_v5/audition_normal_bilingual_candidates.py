"""Audition representative trained normal-Nagato checkpoints and v2 in zh/en."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from normal_context import EXPERIMENT, PROJECT, ROOT, activate, configure_common

common = configure_common()
from audition import synthesize

MODEL_PACKAGE = ROOT / "assets/凉宫春日模型包.part1"
REFERENCE_PACKAGE = ROOT / "assets/凉宫春日参考语音包"
TEXTS = [
    {"id": "zh", "language": "all_zh", "text": "你回来了。今天过得怎么样？如果愿意的话，可以和我说说。"},
    {"id": "en", "language": "en", "text": "You're back. How was your day? If you'd like, you can tell me about it."},
]
CANDIDATE_CHECKPOINTS = [
    ("v5_s2e4_gpte5", 4, 5),
    ("v5_s2e6_gpte10", 6, 10),
    ("v5_s2e8_gpte15", 8, 15),
]


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_english_support() -> dict:
    """Confirm the code and cleaner path accept the exact upstream en code."""
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS_Config
    from text.cleaner import clean_text

    if "en" not in TTS_Config.v2_languages:
        raise RuntimeError("The pinned upstream TTS v2 language list does not contain 'en'.")
    phones, _, normalized = clean_text(TEXTS[1]["text"], "en", "v2")
    if not phones or not normalized:
        raise RuntimeError("The pinned upstream English cleaner returned no phonemes.")
    return {
        "language_code": "en",
        "supported_by_v2_language_list": True,
        "text_cleaner": "text.cleaner.clean_text(language='en', version='v2')",
        "normalized_text": normalized,
        "phoneme_count": len(phones),
        "v5turbo_language_config": "uses the v2 language list for non-v1 versions",
    }


def find_one(pattern: str, folder: Path) -> Path:
    matches = list(folder.glob(pattern))
    if len(matches) != 1:
        raise FileNotFoundError(f"Expected one match for {pattern} in {folder}, found {len(matches)}")
    return matches[0]


def make_job(output: Path, english_check: dict) -> dict:
    character_rows = json.loads((MODEL_PACKAGE / "GPT_weights_v2/characters.json").read_text(encoding="utf-8-sig"))
    normal_chars = [row for row in character_rows
                    if "Nagato_Normal" in row["sovits"] and "Nagato_Normal" in row["gpt"]]
    if len(normal_chars) != 1:
        raise ValueError(f"Expected one normal-timeline Nagato entry; got {len(normal_chars)}")
    character = normal_chars[0]
    ref = character["refs"][0]
    reference_source = REFERENCE_PACKAGE / ref["file"]
    if not reference_source.is_file():
        raise FileNotFoundError(reference_source)
    reference_copy = output / "reference.wav"
    reference_copy.write_bytes(reference_source.read_bytes())

    shared = dict(device="cuda", is_half=True,
                  bert_base_path=str(common.PRETRAINED / "chinese-roberta-wwm-ext-large"),
                  cnhuhbert_base_path=str(common.PRETRAINED / "chinese-hubert-base"))
    model_configs = {}
    for model_name, s2_epoch, gpt_epoch in CANDIDATE_CHECKPOINTS:
        sovits = find_one(f"{EXPERIMENT}_e{s2_epoch}_s*_l16.pth", PROJECT / "weights/sovits")
        gpt = find_one(f"{EXPERIMENT}-e{gpt_epoch}.ckpt", PROJECT / "weights/gpt")
        model_configs[model_name] = dict(**shared, version="v5turbo",
                                        t2s_weights_path=str(gpt), vits_weights_path=str(sovits))
    model_configs["v2_normal"] = dict(
        **shared, version="v2",
        t2s_weights_path=str(MODEL_PACKAGE / character["gpt"]),
        vits_weights_path=str(MODEL_PACKAGE / character["sovits"]),
    )
    for model_name, config in model_configs.items():
        for key in ("t2s_weights_path", "vits_weights_path", "bert_base_path", "cnhuhbert_base_path"):
            if not Path(config[key]).exists():
                raise FileNotFoundError(f"{model_name}: {config[key]}")

    model_details = {}
    for model_name, config in model_configs.items():
        model_details[model_name] = {
            "version": config["version"],
            "sovits_weights_path": config["vits_weights_path"],
            "sovits_sha256": sha(Path(config["vits_weights_path"])),
            "gpt_weights_path": config["t2s_weights_path"],
            "gpt_sha256": sha(Path(config["t2s_weights_path"])),
        }
    return {
        "character": character["name"],
        "experiment": EXPERIMENT,
        "reference": str(reference_copy),
        "reference_source": str(reference_source),
        "reference_sha256": sha(reference_copy),
        "reference_name": ref["name"],
        "prompt_text": ref["text"],
        "prompt_language": "all_ja",
        "texts": TEXTS,
        "english_language_code_verification": english_check,
        "models": model_configs,
        "model_details": model_details,
        "candidate_note": "Representative early/middle/final checkpoint combinations, not a claim that these are validated best checkpoints.",
        "training_performed_by_this_script": False,
        "same_reference_same_texts_same_common_sampling_settings": True,
        "v5_specific_inference": {"sample_steps": 4, "cfg_rate": 0.0},
        "parameters": dict(top_k=15, top_p=1.0, temperature=1.0, speed_factor=1.0,
                            text_split_method="cut0", batch_size=1, seed=1234,
                            parallel_infer=True, use_cuda_graph=False, use_flash_attention=False,
                            repetition_penalty=1.35, streaming_mode=False, fragment_interval=0.3,
                            super_sampling=False),
        "audio_validation_policy": {
            "nonempty_finite_mono_non_silent": True,
            "minimum_duration_seconds": 1.0,
            "clipping_checked": True,
            "subjective_quality_assessment_performed": False,
        },
    }


def make_bilingual_plays(output: Path, job: dict) -> list[dict]:
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    records = []
    for model_name in job["models"]:
        zh_path = output / f"zh_{model_name}.wav"
        en_path = output / f"en_{model_name}.wav"
        zh, zh_rate = sf.read(zh_path, dtype="float32")
        en, en_rate = sf.read(en_path, dtype="float32")
        if zh.ndim != 1 or en.ndim != 1:
            raise ValueError(f"Expected mono samples for {model_name}")
        if en_rate != zh_rate:
            divisor = math.gcd(en_rate, zh_rate)
            en = resample_poly(en, zh_rate // divisor, en_rate // divisor).astype(np.float32)
        gap = np.zeros(round(zh_rate * 0.8), dtype=np.float32)
        paired = np.concatenate((zh, gap, en))
        paired_path = output / f"zh_then_en_{model_name}.wav"
        sf.write(paired_path, paired, zh_rate, subtype="PCM_16")
        records.append({
            "model": model_name,
            "file": str(paired_path),
            "sample_rate": zh_rate,
            "order": ["zh", "0.8-second silence", "en"],
            "zh_seconds": round(len(zh) / zh_rate, 3),
            "en_seconds": round(len(en) / zh_rate, 3),
            "sha256": sha(paired_path),
        })
    return records


def validate_samples(output: Path, job: dict) -> dict:
    import numpy as np
    import soundfile as sf

    validation = {}
    for model_name in job["models"]:
        result_file = output / f"{model_name}.results.json"
        rows = json.loads(result_file.read_text(encoding="utf-8"))["samples"]
        if len(rows) != len(TEXTS):
            raise RuntimeError(f"Expected zh/en samples for {model_name}; found {len(rows)}")
        for row, expected_text in zip(rows, TEXTS):
            if row["text"] != expected_text["text"] or row["language"] != expected_text["language"]:
                raise RuntimeError(f"Text or language code mismatch: {model_name}/{expected_text['id']}")
            audio_path = Path(row["file"])
            audio, sample_rate = sf.read(audio_path, dtype="float32")
            duration = len(audio) / sample_rate if sample_rate else 0
            if (audio.ndim != 1 or not np.isfinite(audio).all() or not np.count_nonzero(audio)
                    or duration < 1.0 or int(np.abs(audio).max() >= 0.9999)):
                raise RuntimeError(f"Invalid audio sample: {audio_path}")
            validation[audio_path.name] = {
                "valid": True,
                "sample_rate": sample_rate,
                "duration_seconds": round(duration, 3),
                "peak_amplitude": round(float(np.abs(audio).max()), 6),
                "rms": round(float(np.sqrt(np.mean(audio ** 2))), 6),
                "samples_at_full_scale": int(np.sum(np.abs(audio) >= 0.9999)),
                "sha256": sha(audio_path),
            }
    return validation


def main() -> None:
    activate()
    import os
    os.chdir(common.REPO)
    english_check = verify_english_support()
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--worker", choices=[name for name, _, _ in CANDIDATE_CHECKPOINTS] + ["v2_normal"])
    args = parser.parse_args()
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d-%H%M%S-bilingual-candidates")
    output = (args.output_dir or ROOT / "outputs/nagato_normal_v5_bilingual_candidates" / stamp).resolve()
    if args.worker:
        job = json.loads((output / "comparison.json").read_text(encoding="utf-8"))
        synthesize(args.worker, output, job)
        return
    output.mkdir(parents=True, exist_ok=True)
    if (output / "comparison.json").exists():
        raise FileExistsError("Choose a new output directory to preserve prior auditions.")
    job = make_job(output, english_check)
    (output / "comparison.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    for model_name in job["models"]:
        print(f"Generating zh/en samples: {model_name}", flush=True)
        with (output / f"{model_name}.log").open("w", encoding="utf-8") as log:
            subprocess.run([str(common.ENV / "python.exe"), "-u", str(Path(__file__).resolve()),
                            "--worker", model_name, "--output-dir", str(output)],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
    job["bilingual_play_files"] = make_bilingual_plays(output, job)
    job["validated_samples"] = validate_samples(output, job)
    job["run_completed"] = True
    (output / "comparison.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "audio_validation.json").write_text(
        json.dumps({"samples": job["validated_samples"], "paired_files": job["bilingual_play_files"],
                    "subjective_quality_assessment_performed": False}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"Completed eight zh/en samples and four combined files: {output}", flush=True)


if __name__ == "__main__":
    main()
