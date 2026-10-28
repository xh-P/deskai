"""Local data inventory, explicit preprocessing, and detached training worker."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

from common import ENV, EXPERIMENT, PRETRAINED, PROJECT, REPO, ROOT, SOURCE, VERSION, activate, write_json


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def audit() -> None:
    rows = []
    for path in sorted(SOURCE.glob("*.wav")):
        with wave.open(str(path), "rb") as wav:
            duration = wav.getnframes() / wav.getframerate()
            rows.append(dict(file=path.name, source=str(path), seconds=duration,
                             sample_rate=wav.getframerate(), channels=wav.getnchannels(),
                             sample_width=wav.getsampwidth(), sha256=sha(path),
                             review_short=duration < 1, review_long=duration > 12))
    if not rows:
        raise RuntimeError(f"No WAV files in {SOURCE}")
    report = dict(source=str(SOURCE), count=len(rows), minutes=sum(r["seconds"] for r in rows) / 60,
                  shorter_than_1s=sum(r["review_short"] for r in rows),
                  longer_than_12s=sum(r["review_long"] for r in rows),
                  labels_status="awaiting_user_supplied_labels; automatic transcription not started",
                  files=rows)
    write_json(PROJECT / "dataset_manifest.json", report)
    print(json.dumps({k: v for k, v in report.items() if k != "files"}, ensure_ascii=False, indent=2))


def configs(features: Path) -> tuple[Path, Path]:
    import yaml
    config_dir = PROJECT / "configs"
    config_dir.mkdir(exist_ok=True)
    for p in (PROJECT / "weights/gpt", PROJECT / "weights/sovits", PROJECT / "checkpoints"):
        p.mkdir(parents=True, exist_ok=True)
    s1 = yaml.safe_load((REPO / "GPT_SoVITS/configs/s1longer-v2.yaml").read_text())
    s1["train"].update(batch_size=1, epochs=15, precision="16-mixed", save_every_n_epoch=5,
                       if_save_latest=True, if_save_every_weights=True, if_dpo=False,
                       accumulate_grad_batches=4,
                       half_weights_save_dir=str(PROJECT / "weights/gpt"), exp_name=EXPERIMENT)
    s1["optimizer"]["fixed_lr"] = 0.002
    s1["data"].update(num_workers=1, max_sec=54)
    s1.update(pretrained_s1=str(PRETRAINED / "s1v3.ckpt"),
              train_semantic_path=str(features / "6-name2semantic.tsv"),
              train_phoneme_path=str(features / "2-name2text.txt"),
              output_dir=str(PROJECT / "checkpoints/gpt"))
    s2 = json.loads((REPO / "GPT_SoVITS/configs/s2.json").read_text())
    s2["train"].update(batch_size=1, epochs=8, fp16_run=True, grad_ckpt=True, lora_rank=16,
                       pretrained_s2G=str(PRETRAINED / "gsv-v5-pretrained/s2Gv5turbo.pth"),
                       pretrained_s2D="", if_save_latest=True, if_save_every_weights=True,
                       save_every_epoch=2, gpu_numbers="0", log_interval=10, num_workers=1)
    s2["model"]["version"] = VERSION
    s2["data"]["exp_dir"] = str(features)
    s2.update(s2_ckpt_dir=str(PROJECT / "checkpoints/sovits"),
              save_weight_dir=str(PROJECT / "weights/sovits"), name=EXPERIMENT, version=VERSION)
    s1_path, s2_path = config_dir / "gpt.yaml", config_dir / "sovits.json"
    s1_path.write_text(yaml.safe_dump(s1, allow_unicode=True, sort_keys=False), encoding="utf-8")
    write_json(s2_path, s2)
    return s1_path, s2_path


def run(entry: str, *args: str, env: dict | None = None) -> None:
    command = [str(ENV / "python.exe"), "-u", str(ROOT / "scripts/gsv_v5/invoke.py"), entry, *args]
    print("RUN " + subprocess.list2cmdline(command), flush=True)
    subprocess.run(command, cwd=REPO, env=env, check=True)


def read_labels() -> tuple[list, list, str]:
    path = PROJECT / "labels.list"
    if not path.exists():
        raise RuntimeError(f"Missing transcript labels: {path}. No transcription or training has been started.")
    inventory = json.loads((PROJECT / "dataset_manifest.json").read_text(encoding="utf-8"))
    source_rows = {r["file"]: r for r in inventory["files"]}
    selected, excluded, seen = [], [], set()
    for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        fields = line.split("|", 3)
        if len(fields) != 4:
            raise ValueError(f"Line {line_no}: expected audio|speaker|language|text")
        original, _, language, text = fields
        name = original.replace("\\", "/").split("/")[-1]
        if name not in source_rows or name in seen:
            raise ValueError(f"Unknown or repeated target recording on line {line_no}: {name}")
        if language.upper() not in {"JA", "JP"}:
            raise ValueError(f"Line {line_no}: expected Japanese JA/JP; verify the source recording language.")
        if not text.strip() or "|" in text:
            raise ValueError(f"Line {line_no}: missing/invalid transcript")
        seen.add(name)
        meta = source_rows[name]
        if sha(Path(meta["source"])) != meta["sha256"]:
            raise ValueError(f"Source recording changed; re-run audit: {name}")
        item = dict(file=name, text=text.strip(), language="JA", seconds=meta["seconds"])
        if not 0 < meta["seconds"] <= 16:
            raise ValueError(f"Selected audio outside supported 0-16 second window: {name}")
        selected.append(item)
    if len(selected) < 20:
        raise ValueError("Fewer than 20 labeled clips; review the labels before preparing.")
    return selected, excluded, sha(path)


def prepare() -> None:
    selected, excluded, digest = read_labels()
    # Keep a fixed listening holdout; it is not used for training or reported as a validation loss.
    holdout_count = max(4, round(len(selected) * 0.05))
    # Keep all user-selected sub-second responses in training. Hold out ordinary dialogue.
    candidates = [r for r in selected if 3 <= r["seconds"] <= 10]
    holdout = random.Random(1234).sample(candidates, holdout_count)
    holdout_names = {r["file"] for r in holdout}
    train = [r for r in selected if r["file"] not in holdout_names]
    features = PROJECT / "features" / digest[:12]
    features.mkdir(parents=True, exist_ok=True)
    audio = PROJECT / "audio"
    audio.mkdir(exist_ok=True)
    audio_manifest = []
    for row in selected:
        target = audio / row["file"]
        source = SOURCE / row["file"]
        padded = row["file"] not in holdout_names and row["seconds"] <= 0.66
        if padded:
            # Upstream S2's bucket sampler rejects <=32 frames. Preserve PCM, append silence only.
            with wave.open(str(source), "rb") as src:
                params = src.getparams()
                data = src.readframes(src.getnframes())
                extra_frames = max(0, round(0.70 * src.getframerate()) - src.getnframes())
            if params.sampwidth != 2:
                raise ValueError(f"Expected PCM16 before silence padding: {source}")
            with wave.open(str(target), "wb") as dst:
                dst.setparams(params)
                dst.writeframes(data + b"\0" * (extra_frames * params.nchannels * params.sampwidth))
        elif not target.exists() or sha(target) != sha(source):
            shutil.copy2(SOURCE / row["file"], target)
        audio_manifest.append(dict(file=row["file"], source_sha256=sha(source), prepared_sha256=sha(target),
            original_seconds=row["seconds"], padded_to_seconds=0.70 if padded else None,
            split="holdout" if row["file"] in holdout_names else "train"))
    write_json(PROJECT / "inputs/prepared_audio.json", dict(files=audio_manifest,
        policy="Append zero PCM to 0.70s only for training clips <=0.66s; preserve original files."))
    def save_list(filename, items):
        (PROJECT / filename).write_text("\n".join(
            f"{(audio / r['file']).as_posix()}|{EXPERIMENT}|JA|{r['text']}" for r in items) + "\n", encoding="utf-8")
    save_list("train.list", train)
    save_list("holdout.list", holdout)
    write_json(PROJECT / "excluded.json", {"recordings": excluded})
    env = os.environ.copy()
    env.update(inp_text=str(PROJECT / "train.list"), inp_wav_dir=str(audio), exp_name=EXPERIMENT,
               i_part="0", all_parts="1", opt_dir=str(features), is_half="True",
               bert_pretrained_dir=str(PRETRAINED / "chinese-roberta-wwm-ext-large"),
               cnhubert_base_dir=str(PRETRAINED / "chinese-hubert-base"),
               pretrained_s2G=str(PRETRAINED / "gsv-v5-pretrained/s2Gv5turbo.pth"),
               s2config_path=str(REPO / "GPT_SoVITS/configs/s2.json"))
    run("GPT_SoVITS/prepare_datasets/1-get-text.py", env=env)
    run("GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py", env=env)
    run("GPT_SoVITS/prepare_datasets/3-get-semantic.py", env=env)
    shutil.copy2(features / "2-name2text-0.txt", features / "2-name2text.txt")
    semantic = (features / "6-name2semantic-0.tsv").read_text(encoding="utf-8")
    (features / "6-name2semantic.tsv").write_text("item_name\tsemantic_audio\n" + semantic, encoding="utf-8")
    names = {r["file"] for r in train}
    for filename in ("2-name2text.txt", "6-name2semantic-0.tsv"):
        actual = {line.split("\t", 1)[0] for line in (features / filename).read_text(encoding="utf-8").splitlines() if line}
        if actual != names:
            raise RuntimeError(f"Incomplete {filename}: missing={sorted(names - actual)}; inspect preprocessing log.")
    for name in names:
        if not (features / "4-cnhubert" / (name + ".pt")).exists() or not (features / "5-wav32k" / name).exists():
            raise RuntimeError(f"Missing audio features for {name}")
    configs(features)
    write_json(PROJECT / "ready.json", dict(labels_sha256=digest, features=str(features),
               training_clips=len(train), holdout_clips=len(holdout), excluded_clips=len(excluded), version=VERSION,
               train_list_sha256=sha(PROJECT / "train.list"),
               prepared_audio_manifest_sha256=sha(PROJECT / "inputs/prepared_audio.json")))
    print("Preprocessing complete. Training has NOT been started.", flush=True)


def state(status: str, **extra) -> None:
    write_json(PROJECT / "status.json", dict(status=status, pid=os.getpid(),
               updated_at=datetime.now(timezone.utc).isoformat(), **extra))


def preflight() -> None:
    ready_path = PROJECT / "ready.json"
    if not ready_path.is_file():
        raise RuntimeError("Preprocessing is not complete; run prepare-nagato-v5.cmd first.")
    ready = json.loads(ready_path.read_text(encoding="utf-8"))
    for relative, key in (("labels.list", "labels_sha256"), ("train.list", "train_list_sha256"),
                          ("inputs/prepared_audio.json", "prepared_audio_manifest_sha256")):
        if ready.get(key) != sha(PROJECT / relative):
            raise RuntimeError(f"Prepared input changed: {relative}; prepare and validate again.")
    manifest = json.loads((PROJECT / "inputs/prepared_audio.json").read_text(encoding="utf-8"))
    for row in manifest["files"]:
        if sha(PROJECT / "audio" / row["file"]) != row["prepared_sha256"]:
            raise RuntimeError(f"Prepared audio changed: {row['file']}")
    for stage in ("inventory", "sovits", "gpt"):
        check_path = PROJECT / "checks" / f"real-data-{stage}.json"
        if not check_path.is_file():
            raise RuntimeError(f"Real-data validation is pending: {stage}")
        check = json.loads(check_path.read_text(encoding="utf-8"))
        if not check.get("success"):
            raise RuntimeError(f"Real-data validation failed: {stage}")
        for filename, digest in check["configs_sha256"].items():
            if sha(Path(filename)) != digest:
                raise RuntimeError("Training parameters changed after validation; rerun real-data checks.")
    print("READY: v5 Turbo, verified input audio and real-data checks. No training started by this check.", flush=True)


def train(stage: str) -> None:
    preflight()
    ready_path = PROJECT / "ready.json"
    if not ready_path.exists():
        raise RuntimeError("No ready.json: transcripts and preprocessing must be completed first.")
    ready = json.loads(ready_path.read_text(encoding="utf-8"))
    if ready["labels_sha256"] != sha(PROJECT / "labels.list"):
        raise RuntimeError("Labels changed since preprocessing; prepare again first.")
    data_lock = PROJECT / "checkpoints/dataset.sha256"
    if data_lock.exists() and data_lock.read_text().strip() != ready["labels_sha256"]:
        raise RuntimeError("Existing checkpoints belong to different labels. Use a new experiment to avoid mixing runs.")
    data_lock.parent.mkdir(exist_ok=True)
    data_lock.write_text(ready["labels_sha256"], encoding="ascii")
    import msvcrt
    lock = (PROJECT / "training.lock").open("a+b")
    if lock.tell() == 0:
        lock.write(b"0")
        lock.flush()
    lock.seek(0)
    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    ctypes.windll.kernel32.SetThreadExecutionState(0x80000001)
    try:
        from download_models import FILES, DEST, matches
        for name, size, kind, digest in FILES:
            if not matches(DEST / name, size, kind, digest):
                raise RuntimeError(f"Missing/corrupt base model: {name}")
        s1, s2 = PROJECT / "configs/gpt.yaml", PROJECT / "configs/sovits.json"
        stages = ["sovits", "gpt"] if stage == "all" else [stage]
        for current in stages:
            state("running", stage=current, version=VERSION)
            if current == "sovits":
                run("GPT_SoVITS/s2_train_v3_lora.py", "--config", str(s2))
            else:
                run("GPT_SoVITS/s1_train.py", "--config_file", str(s1))
        state("completed", stage=stage, version=VERSION)
    except BaseException as exc:
        state("failed", stage=stage, error=str(exc), version=VERSION)
        raise
    finally:
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        lock.close()


def main() -> None:
    activate()
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["audit", "configure", "prepare", "preflight", "train", "ui"])
    parser.add_argument("--stage", choices=["all", "sovits", "gpt"], default="all")
    args = parser.parse_args()
    if args.action == "audit":
        audit()
    elif args.action == "configure":
        configs(PROJECT / "features/pending_labels")
        print("Draft v5 Turbo configs created; waiting for transcripts.")
    elif args.action == "prepare":
        prepare()
    elif args.action == "preflight":
        preflight()
    elif args.action == "train":
        train(args.stage)
    else:
        os.environ.setdefault("GSV_OPEN_BROWSER", "1")
        run("webui.py", "zh_CN")


if __name__ == "__main__":
    main()
