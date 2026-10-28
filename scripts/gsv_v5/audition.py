"""Generate comparable zero-shot v5 and supplied v2 samples; never train."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

from common import ENV, PRETRAINED, REPO, ROOT, activate, write_json

DEFAULT_TEXTS = [
    {"id": "zh", "language": "all_zh", "text": "你回来了。今天过得怎么样？如果愿意的话，可以和我说说。"},
    {"id": "ja", "language": "all_ja", "text": "お帰りなさい。今日は、どんな一日だった？よかったら、少しだけ話を聞かせて。"},
]


def make_job(args, output: Path):
    models = ROOT / "assets/凉宫春日模型包.part1"
    characters = json.loads((models / "GPT_weights_v2/characters.json").read_text(encoding="utf-8-sig"))
    character = next(c for c in characters if "Nagato_Disappearance" in c["sovits"])
    ref = character["refs"][args.reference - 1]
    source = ROOT / "assets/凉宫春日参考语音包" / ref["file"]
    reference = output / "reference.wav"
    shutil.copy2(source, reference)
    texts = DEFAULT_TEXTS if args.text is None else [dict(id=args.language, language="all_" + args.language, text=args.text)]
    shared = dict(device="cuda", is_half=True,
                  bert_base_path=str(PRETRAINED / "chinese-roberta-wwm-ext-large"),
                  cnhuhbert_base_path=str(PRETRAINED / "chinese-hubert-base"))
    configs = {
        "v5_base": dict(**shared, version="v5turbo", t2s_weights_path=str(PRETRAINED / "s1v3.ckpt"),
                        vits_weights_path=str(PRETRAINED / "gsv-v5-pretrained/s2Gv5turbo.pth")),
        "v2_tuned": dict(**shared, version="v2", t2s_weights_path=str(models / character["gpt"]),
                         vits_weights_path=str(models / character["sovits"])),
    }
    for config in configs.values():
        for key in ("t2s_weights_path", "vits_weights_path", "bert_base_path", "cnhuhbert_base_path"):
            if not Path(config[key]).exists():
                raise FileNotFoundError(config[key])
    job = dict(character=character["name"], reference=str(reference), reference_source=str(source),
               reference_sha256=hashlib.sha256(reference.read_bytes()).hexdigest(),
               prompt_text=ref["text"], prompt_language="all_ja", reference_name=ref["name"],
               texts=texts, models=configs, training_performed=False,
               parameters=dict(top_k=15, top_p=1.0, temperature=1.0, speed_factor=1.0,
                               text_split_method="cut0", batch_size=1, seed=1234,
                               parallel_infer=True, use_cuda_graph=False, use_flash_attention=False,
                               repetition_penalty=1.35, streaming_mode=False, fragment_interval=0.3,
                               super_sampling=False))
    write_json(output / "comparison.json", job)
    return job


def synthesize(model_name: str, output: Path, job: dict):
    import numpy as np
    import soundfile as sf
    import torch
    config = job["models"][model_name]
    os.environ["version"] = config["version"]
    os.chdir(REPO)
    from tools.portable_runtime import activate as activate_portable
    activate_portable(change_cwd=True)
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

    torch.set_num_threads(4)
    assert torch.cuda.is_available(), "CUDA is unavailable"
    tts_config = TTS_Config({"custom": config})
    # Upstream saves settings while loading models; keep those writes in this audition.
    tts_config.configs_path = str(output / (model_name + ".yaml"))
    started = time.perf_counter()
    pipeline = TTS(tts_config)
    load_seconds = round(time.perf_counter() - started, 3)
    assert pipeline.configs.version == config["version"], pipeline.configs.version
    results = []
    for item in job["texts"]:
        request = dict(job["parameters"], text=item["text"], text_lang=item["language"],
                       ref_audio_path=job["reference"], prompt_text=job["prompt_text"],
                       prompt_lang=job["prompt_language"])
        if config["version"] == "v5turbo":
            request.update(sample_steps=4, cfg_rate=0.0)
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        # Exhaust the generator so an upstream exception cannot be mistaken for its silent fallback.
        chunks = list(pipeline.run(request))
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        if not chunks or len({sr for sr, _ in chunks}) != 1:
            raise RuntimeError("No audio or mixed sample rates")
        sample_rate = chunks[0][0]
        audio = np.concatenate([audio for _, audio in chunks])
        if audio.ndim != 1 or not np.isfinite(audio).all() or np.count_nonzero(audio) == 0:
            raise RuntimeError("Invalid/silent generated audio")
        path = output / f"{item['id']}_{model_name}.wav"
        sf.write(path, audio, sample_rate, subtype="PCM_16")
        pcm, read_sr = sf.read(path, dtype="float32")
        duration = len(pcm) / read_sr
        if duration < 1:
            raise RuntimeError(f"Unexpectedly short audio: {duration}")
        row = dict(model=model_name, version=pipeline.configs.version, text=item["text"],
                   language=item["language"], file=str(path), sample_rate=read_sr,
                   duration_seconds=round(duration, 3), inference_seconds=round(elapsed, 3),
                   real_time_factor=round(elapsed / duration, 3),
                   model_load_seconds=load_seconds, first_request=len(results) == 0,
                   peak_allocated_mib=round(torch.cuda.max_memory_allocated() / 2**20),
                   peak_amplitude=round(float(np.abs(pcm).max()), 6),
                   rms=round(float(np.sqrt(np.mean(pcm**2))), 6),
                   samples_at_full_scale=int(np.sum(np.abs(pcm) >= 0.9999)),
                   sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        results.append(row)
        write_json(output / (model_name + ".results.json"), dict(samples=results))
        print("SAMPLE " + json.dumps(row, ensure_ascii=False), flush=True)


def main():
    activate()
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["all", "v5_base", "v2_tuned"], default="all")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--text")
    parser.add_argument("--language", choices=["zh", "ja"], default="zh")
    parser.add_argument("--reference", type=int, choices=range(1, 9), default=3)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d-%H%M%S")
    output = (args.output_dir or ROOT / "outputs/nagato_audition" / stamp).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.worker:
        if args.model == "all":
            raise ValueError("Worker requires one model")
        job = json.loads((output / "comparison.json").read_text(encoding="utf-8"))
        synthesize(args.model, output, job)
        return
    if (output / "comparison.json").exists():
        raise FileExistsError("Choose a new output directory to preserve previous auditions")
    make_job(args, output)
    targets = ["v5_base", "v2_tuned"] if args.model == "all" else [args.model]
    for target in targets:
        # Separate processes release all CUDA resources before loading the next model.
        log = output / (target + ".log")
        print(f"Generating {target}; log: {log}", flush=True)
        with log.open("w", encoding="utf-8") as stream:
            subprocess.run([str(ENV / "python.exe"), "-u", str(Path(__file__).resolve()),
                            "--worker", "--model", target, "--output-dir", str(output)],
                           cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=True)
    print(f"Audition complete: {output}", flush=True)


if __name__ == "__main__":
    main()
