"""Compare normal-Nagato v5 Turbo checkpoints with the supplied normal v2 model."""
from __future__ import annotations

import argparse
import math
import hashlib
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from normal_context import EXPERIMENT, PROJECT, ROOT, activate, configure_common

common = configure_common()
from audition import synthesize

MODELS = ROOT / "assets/凉宫春日模型包.part1"
REFERENCES = ROOT / "assets/凉宫春日参考语音包"


def make_job(output: Path, reference: int) -> dict:
    characters = json.loads((MODELS / "GPT_weights_v2/characters.json").read_text(encoding="utf-8-sig"))
    matches = [c for c in characters if "Nagato_Normal" in c["sovits"] and "Nagato_Normal" in c["gpt"]]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one normal Nagato v2 character entry; found {len(matches)}")
    character = matches[0]
    ref = character["refs"][reference - 1]
    reference_source = REFERENCES / ref["file"]
    if not reference_source.is_file():
        raise FileNotFoundError(reference_source)
    reference_copy = output / "reference.wav"
    reference_copy.write_bytes(reference_source.read_bytes())

    holdout = PROJECT / "holdout.list"
    if not holdout.is_file():
        raise FileNotFoundError("Prepare and hold out normal-Nagato data before auditioning.")
    holdout_line = next((line for line in holdout.read_text(encoding="utf-8").splitlines() if line.strip()), None)
    if not holdout_line:
        raise ValueError("Normal-Nagato holdout list is empty.")
    original, speaker, language, text = holdout_line.split("|", 3)
    if speaker != EXPERIMENT or language != "JA":
        raise ValueError("Holdout line belongs to a different experiment or language.")
    if any(original == line.split("|", 1)[0] for line in (PROJECT / "train.list").read_text(encoding="utf-8").splitlines() if line.strip()):
        raise ValueError("The audition transcript appears in train.list.")

    shared = dict(device="cuda", is_half=True,
                  bert_base_path=str(common.PRETRAINED / "chinese-roberta-wwm-ext-large"),
                  cnhuhbert_base_path=str(common.PRETRAINED / "chinese-hubert-base"))
    final_sovits = list((PROJECT / "weights/sovits").glob(f"{EXPERIMENT}_e8_s*_l16.pth"))
    if len(final_sovits) != 1:
        raise FileNotFoundError(f"Expected one final SoVITS e8 export, found {len(final_sovits)}")
    configs = {
        "v5_base": dict(**shared, version="v5turbo", t2s_weights_path=str(common.PRETRAINED / "s1v3.ckpt"),
                        vits_weights_path=str(common.PRETRAINED / "gsv-v5-pretrained/s2Gv5turbo.pth")),
        "v5_trained": dict(**shared, version="v5turbo",
                            t2s_weights_path=str(PROJECT / f"weights/gpt/{EXPERIMENT}-e15.ckpt"),
                            vits_weights_path=str(final_sovits[0])),
        "v2_normal": dict(**shared, version="v2",
                          t2s_weights_path=str(MODELS / character["gpt"]),
                          vits_weights_path=str(MODELS / character["sovits"])),
    }
    # The S2 filename counts optimizer steps, which equals train clips times epochs here.
    for name, config in configs.items():
        for key in ("t2s_weights_path", "vits_weights_path", "bert_base_path", "cnhuhbert_base_path"):
            if not Path(config[key]).exists():
                raise FileNotFoundError(f"{name}: {config[key]}")

    texts = [dict(id="ja_holdout", language="all_ja", text=text),
             dict(id="ja_novel", language="all_ja", text="少しだけ、話を聞かせて。私はここにいる。")]
    return dict(character=character["name"], experiment=EXPERIMENT,
                reference=str(reference_copy), reference_source=str(reference_source),
                reference_sha256=hashlib.sha256(reference_copy.read_bytes()).hexdigest(),
                prompt_text=ref["text"], prompt_language="all_ja", reference_name=ref["name"],
                texts=texts, models=configs, holdout_original=original,
                holdout_not_used_for_training=True,
                training_performed_by_this_script=False,
                trained_checkpoints={"v5_trained": {"sovits_epoch": 8, "gpt_epoch": 15,
                    "sovits_sha256": hashlib.sha256(Path(configs["v5_trained"]["vits_weights_path"]).read_bytes()).hexdigest(),
                    "gpt_sha256": hashlib.sha256(Path(configs["v5_trained"]["t2s_weights_path"]).read_bytes()).hexdigest()}},
                comparison_note="All models use the same normal-Nagato reference audio, Japanese prompts, inference settings, and seed. One transcript is a held-out source clip excluded from training; the other is unseen dialogue.",
                parameters=dict(top_k=15, top_p=1.0, temperature=1.0, speed_factor=1.0,
                                text_split_method="cut0", batch_size=1, seed=1234,
                                parallel_infer=True, use_cuda_graph=False, use_flash_attention=False,
                                repetition_penalty=1.35, streaming_mode=False, fragment_interval=0.3,
                                super_sampling=False))


def make_pairs(output: Path) -> None:
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    job = json.loads((output / "comparison.json").read_text(encoding="utf-8"))
    rows = []
    for item in job["texts"]:
        v5_path = output / f"{item['id']}_v5_trained.wav"
        v2_path = output / f"{item['id']}_v2_normal.wav"
        v5, v5_rate = sf.read(v5_path, dtype="float32")
        v2, v2_rate = sf.read(v2_path, dtype="float32")
        if v5.ndim != 1 or v2.ndim != 1:
            raise ValueError("Expected mono audition samples for a direct pair.")
        if v2_rate != v5_rate:
            divisor = math.gcd(v2_rate, v5_rate)
            v2 = resample_poly(v2, v5_rate // divisor, v2_rate // divisor).astype(np.float32)
        separator = np.zeros(round(v5_rate * 0.8), dtype=np.float32)
        paired = np.concatenate((v5, separator, v2))
        path = output / f"{item['id']}_v5_trained_then_v2_normal.wav"
        sf.write(path, paired, v5_rate, subtype="PCM_16")
        rows.append(dict(text_id=item["id"], text=item["text"], file=str(path), sample_rate=v5_rate,
                         order=["v5_trained", "0.8-second silence", "v2_normal"],
                         v5_seconds=round(len(v5) / v5_rate, 3), v2_seconds=round(len(v2) / v5_rate, 3)))
    (output / "paired_comparisons.json").write_text(
        json.dumps(dict(note="Identical text and reference; v2 is resampled only to match the v5 sample rate.", pairs=rows),
                   ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    activate()
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--reference", type=int, choices=range(1, 5), default=1)
    parser.add_argument("--worker", choices=["v5_base", "v5_trained", "v2_normal"])
    parser.add_argument("--make-pairs-only", action="store_true")
    args = parser.parse_args()
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d-%H%M%S-normal")
    output = (args.output_dir or ROOT / "outputs/nagato_normal_v5_comparison" / stamp).resolve()
    if args.make_pairs_only:
        make_pairs(output)
        print(f"Wrote paired samples: {output}", flush=True)
        return
    if args.worker:
        job = json.loads((output / "comparison.json").read_text(encoding="utf-8"))
        synthesize(args.worker, output, job)
        return
    output.mkdir(parents=True, exist_ok=True)
    if (output / "comparison.json").exists():
        raise FileExistsError("Choose a fresh output directory to preserve earlier comparisons.")
    job = make_job(output, args.reference)
    (output / "comparison.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    for model_name in ("v5_trained", "v2_normal", "v5_base"):
        print(f"Generating {model_name}: {output}", flush=True)
        log_path = output / f"{model_name}.log"
        with log_path.open("w", encoding="utf-8") as log:
            subprocess.run([str(common.ENV / "python.exe"), "-u", str(Path(__file__).resolve()),
                            "--worker", model_name, "--output-dir", str(output)],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
    make_pairs(output)
    print(f"Completed {len(job['texts']) * 3} same-text audition samples: {output}", flush=True)


if __name__ == "__main__":
    main()
