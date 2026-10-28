"""Trained v5 Turbo versus existing v2, with per-language warmup and raw evidence."""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import platform
from pathlib import Path
import statistics
import subprocess
import sys
import threading
import time
import traceback

PROCESS_START = time.perf_counter()
from common import ENV, REPO, ROOT, activate, write_json
from benchmark import MODES, ResourceSampler


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def windows_cpu_name():
    if sys.platform != "win32":
        return platform.processor()
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
        return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()


def windows_power_plan():
    if sys.platform != "win32":
        return None
    result = subprocess.run(["powercfg", "/getactivescheme"], capture_output=True, text=True,
                            encoding="utf-8", errors="replace")
    return result.stdout.strip() if result.returncode == 0 else None


def worker(args, output, job):
    import numpy as np
    import psutil
    import soundfile as sf
    import torch
    config = job["models"][args.model]
    os.environ["version"] = config["version"]
    os.chdir(REPO)
    from tools.portable_runtime import activate as portable_activate
    portable_activate(change_cwd=True)
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
    from process_ckpt import get_sovits_version_from_path_fast
    torch.set_num_threads(4)
    expected = job.get("trained_checkpoints", {}).get(args.model, {}).get("hashes", {})
    hashes = {name: sha256(config[name]) for name in ("t2s_weights_path", "vits_weights_path")}
    if expected and hashes != expected:
        raise RuntimeError(f"Checkpoint hash changed: {hashes} != {expected}")
    sovits_detection = get_sovits_version_from_path_fast(config["vits_weights_path"])
    if args.model == "v5_s2e2_gpte10" and list(sovits_detection) != ["v2", "v5turbo", True]:
        raise RuntimeError(f"Expected v5 Turbo LoRA checkpoint: {sovits_detection}")
    sampler = ResourceSampler()
    sampler.start()
    tts_config = TTS_Config({"custom": config})
    tts_config.configs_path = str(output / (args.model + ".yaml"))
    torch.cuda.reset_peak_memory_stats()
    before_load = time.perf_counter()
    pipeline = TTS(tts_config)
    torch.cuda.synchronize()
    ready_at = time.perf_counter()
    report = dict(model=args.model, version=config["version"], checkpoint_sha256=hashes,
                  request_overrides={"sample_steps": 4, "cfg_rate": 0.0} if args.model == "v5_s2e2_gpte10" else {},
                  sovits_detection=sovits_detection,
                  loaded_paths={name: str(getattr(pipeline.configs, name)) for name in hashes},
                  model_load_seconds=round(ready_at - before_load, 4),
                  process_to_models_ready_seconds=round(ready_at - PROCESS_START, 4),
                  load_peak_allocated_mib=round(torch.cuda.max_memory_allocated() / 2**20, 2),
                  loaded_allocated_mib=round(torch.cuda.memory_allocated() / 2**20, 2),
                  loaded_rss_mib=round(psutil.Process().memory_info().rss / 2**20, 2),
                  load_resources=sampler.summary(before_load, ready_at), samples=[], failures=[])
    if any(Path(report["loaded_paths"][name]).resolve() != Path(config[name]).resolve() for name in hashes):
        raise RuntimeError(f"Loaded paths differ from request: {report['loaded_paths']}")
    result_path = output / (args.model + ".json")
    write_json(result_path, report)

    def measure(mode, text, phase, repeat):
        request = dict(job["parameters"], text=text["text"], text_lang=text["language"],
                       ref_audio_path=job["reference"], prompt_text=job["prompt_text"],
                       prompt_lang=job["prompt_language"], **{})
        request.update(MODES[mode])
        if args.model == "v5_s2e2_gpte10":
            request.update(sample_steps=4, cfg_rate=0.0)
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        before_cpu = sampler.ps.cpu_times()
        start = time.perf_counter()
        chunks, arrivals = [], []
        rates = set()
        for sr, audio in pipeline.run(request):
            if len(audio):
                arrivals.append(dict(at_seconds=time.perf_counter() - start,
                                     duration_seconds=len(audio) / sr,
                                     non_silent=bool(np.count_nonzero(audio))))
                rates.add(sr)
                chunks.append(audio)
        torch.cuda.synchronize()
        end = time.perf_counter()
        after_cpu = sampler.ps.cpu_times()
        if len(rates) != 1 or not chunks or not any(x["non_silent"] for x in arrivals):
            raise RuntimeError("No valid audio was produced")
        sr = rates.pop()
        audio = np.concatenate(chunks)
        if not np.isfinite(audio).all():
            raise RuntimeError("Non-finite audio")
        duration = len(audio) / sr
        first_pcm = next(x["at_seconds"] for x in arrivals if x["non_silent"])
        # Earliest playback starts at first nonzero PCM; gaps are only a timing model.
        playback_end = first_pcm
        slack = []
        gaps = []
        for arrival in arrivals:
            at = arrival["at_seconds"]
            if playback_end > first_pcm:
                slack.append(playback_end - at)
                gaps.append(max(0.0, at - playback_end))
            playback_end = max(playback_end, at) + arrival["duration_seconds"]
        active_accel = pipeline.streaming_accel if mode == "v5_semantic_stream" else pipeline.t2s_accel
        cpu_seconds = after_cpu.user + after_cpu.system - before_cpu.user - before_cpu.system
        row = dict(mode=mode, language=text["id"], phase=phase, repeat=repeat,
                   text=text["text"], seed=request["seed"],
                   sample_steps=request.get("sample_steps"), cfg_rate=request.get("cfg_rate"),
                   duration_seconds=round(duration, 4),
                   total_seconds=round(end-start, 4), first_pcm_seconds=round(first_pcm, 4),
                   rtf=round((end-start)/duration, 4), chunks=len(chunks),
                   first_chunk_duration_seconds=round(arrivals[0]["duration_seconds"], 4),
                   playback_min_slack_seconds=round(min(slack), 4) if slack else None,
                   playback_max_gap_seconds=round(max(gaps), 4) if gaps else None,
                   cpu_core_equivalents=round(cpu_seconds/(end-start), 3),
                   allocated_peak_mib=round(torch.cuda.max_memory_allocated()/2**20, 2),
                   reserved_peak_mib=round(torch.cuda.max_memory_reserved()/2**20, 2),
                   acceleration_backend=getattr(active_accel, "backend", None),
                   cuda_graph_active=bool(getattr(active_accel, "graph_enabled", False)),
                   resources=sampler.summary(start,end), arrivals=arrivals)
        if repeat == 0 and phase == "measured":
            path = output / f"{args.model}-{mode}-{text['id']}.wav"
            sf.write(path, audio, sr, subtype="PCM_16")
            row["audio_file"] = str(path)
        report["samples"].append(row)
        write_json(result_path, report)
        print("BENCH " + json.dumps({k:v for k,v in row.items() if k not in ("arrivals","resources","text")}), flush=True)

    modes = ["full_baseline", "full_cuda_graph", "sentence_cuda_graph",
             "v2_fixed_stream" if args.model == "v2_tuned" else "v5_semantic_stream"]
    try:
        for mode in modes:
            for name in ("t2s_accel", "streaming_accel"):
                accelerator = getattr(pipeline,name)
                if accelerator:
                    accelerator.close()
                    setattr(pipeline,name,None)
            gc.collect()
            torch.cuda.empty_cache()
            try:
                measure(mode,job["texts"][0],"first_call" if mode=="full_baseline" else "mode_setup",-2)
                for text in job["texts"]:
                    measure(mode,text,"language_warmup",-1)
                for text in job["texts"]:
                    for repeat in range(args.repeats):
                        measure(mode,text,"measured",repeat)
            except Exception as exc:
                traceback.print_exc()
                report["failures"].append(dict(mode=mode,error=str(exc),traceback=traceback.format_exc()))
                write_json(result_path,report)
    finally:
        sampler.stop()
        write_json(output/(args.model+".resources.json"),dict(samples=sampler.records))
    report["complete"] = not report["failures"] and len([s for s in report["samples"] if s["phase"] == "measured"]) == 4*3*args.repeats
    write_json(result_path,report)
    if not report["complete"]:
        raise RuntimeError(f"Benchmark incomplete for {args.model}: {len(report['failures'])} failures")


def aggregate(output, models, job, repeats, metadata):
    reports = {model: json.loads((output / f"{model}.json").read_text(encoding="utf-8")) for model in models}
    rows = []
    for model, report in reports.items():
        modes = ["full_baseline", "full_cuda_graph", "sentence_cuda_graph",
                 "v2_fixed_stream" if model == "v2_tuned" else "v5_semantic_stream"]
        for mode in modes:
            for language in [item["id"] for item in job["texts"]]:
                samples = [s for s in report["samples"] if s["phase"] == "measured" and s["mode"] == mode and s["language"] == language]
                if len(samples) != repeats:
                    raise RuntimeError(f"Missing measured requests: {model}/{mode}/{language}: {len(samples)}")
                row = dict(model=model, mode=mode, language=language, n=len(samples))
                for metric in ("first_pcm_seconds", "total_seconds", "duration_seconds", "rtf", "cpu_core_equivalents",
                               "allocated_peak_mib", "reserved_peak_mib", "playback_min_slack_seconds", "playback_max_gap_seconds"):
                    values = [s[metric] for s in samples if s.get(metric) is not None]
                    row[metric] = {key: round(func(values), 4) for key,func in (("median",statistics.median),("min",min),("max",max))} if values else None
                for key, src in (("rss_peak_mib", "rss_mib_peak"), ("gpu_power_mean_w", "gpu_board_power_w_mean"),
                                 ("gpu_board_used_peak_mib", "gpu_total_used_mib_peak")):
                    values = [s["resources"][src] for s in samples if src in s["resources"]]
                    row[key] = {name: round(fn(values), 4) for name,fn in (("median",statistics.median),("min",min),("max",max))} if values else None
                row["audio_file"] = next((s.get("audio_file") for s in samples if s.get("audio_file")), None)
                row["cuda_graph_active"] = all(s["cuda_graph_active"] for s in samples)
                row["acceleration_backends"] = sorted({str(s["acceleration_backend"]) for s in samples})
                rows.append(row)
    metadata.update(all_requests=sum(len(r["samples"]) for r in reports.values()),
                    timed_warm_requests=sum(len([s for s in r["samples"] if s["phase"] == "measured"]) for r in reports.values()),
                    language_warmup_requests=sum(len([s for s in r["samples"] if s["phase"] == "language_warmup"]) for r in reports.values()),
                    checkpoint_sha256={m:r["checkpoint_sha256"] for m,r in reports.items()},
                    model_load_seconds={m:r["model_load_seconds"] for m,r in reports.items()},
                    failures={m:r["failures"] for m,r in reports.items()})
    summary = dict(metadata=metadata, rows=rows, cold=[dict(model=m, **s) for m,r in reports.items() for s in r["samples"] if s["phase"] in ("first_call", "mode_setup", "language_warmup")])
    write_json(output / "summary.json", summary)


def main():
    activate()
    parser=argparse.ArgumentParser()
    parser.add_argument("--model",choices=["all","v2_tuned","v5_s2e2_gpte10"],default="all")
    parser.add_argument("--repeats",type=int,default=5)
    parser.add_argument("--output-dir",type=Path,required=True)
    parser.add_argument("--worker",action="store_true")
    args=parser.parse_args()
    output=args.output_dir.resolve()
    output.mkdir(parents=True,exist_ok=True)
    job=json.loads((ROOT/"outputs/nagato_audition/20261024-trained-ab/comparison.json").read_text(encoding="utf-8"))
    if args.worker:
        worker(args,output,job)
        return
    import datetime
    import psutil
    import torch
    import soundfile as sf
    import pynvml as nv
    nv.nvmlInit()
    handle = nv.nvmlDeviceGetHandleByIndex(0)
    nv_name = nv.nvmlDeviceGetName(handle)
    metadata = dict(date=datetime.datetime.now().astimezone().isoformat(), os=platform.platform(),
                    cpu=windows_cpu_name(), cpu_logical_processors=psutil.cpu_count(), ram_gib=round(psutil.virtual_memory().total/2**30,3),
                    power_plan=windows_power_plan(),
                    gpu=nv_name.decode() if isinstance(nv_name,bytes) else nv_name,
                    vram_mib=round(nv.nvmlDeviceGetMemoryInfo(handle).total/2**20),
                    background_gpu_used_mib=round(nv.nvmlDeviceGetMemoryInfo(handle).used/2**20,2),
                    background_gpu_util_pct=nv.nvmlDeviceGetUtilizationRates(handle).gpu,
                    background_gpu_board_power_w=round(nv.nvmlDeviceGetPowerUsage(handle)/1000,3),
                    driver=nv.nvmlSystemGetDriverVersion(), torch=torch.__version__, python=platform.python_version(),
                    threads=4,batch_size=1,fp16=True,flash_attention=False,repeats=args.repeats,
                    seed=job["parameters"]["seed"],reference=job["reference"],reference_sha256=sha256(job["reference"]),
                    v5_request_overrides={"sample_steps":4,"cfg_rate":0.0},
                    reference_seconds=round(sf.info(job["reference"]).duration,4),
                    notes="One request at a time, per-mode and per-text warmup. Resident model; no network or playback device. 50 ms resource sampling. RSS is process memory; NVML memory and power are whole-board including other apps. Playback gaps are simulated from chunk arrivals. Windows file cache not cleared.")
    if metadata["reference_sha256"] != job["reference_sha256"]:
        raise RuntimeError("Reference audio hash changed")
    write_json(output/"method.json",dict(repeats=args.repeats,request=job,modes=MODES,metadata=metadata,
               v5_request_overrides={"sample_steps":4,"cfg_rate":0.0}))
    models = ["v2_tuned","v5_s2e2_gpte10"] if args.model=="all" else [args.model]
    for model in models:
        if (output/(model+".json")).exists():
            raise FileExistsError(f"Preserve existing benchmark: {model}")
        with (output/(model+".log")).open("w",encoding="utf-8") as log:
            print(f"Benchmarking {model}: {output}",flush=True)
            subprocess.run([str(ENV/"python.exe"),"-u",str(Path(__file__).resolve()),"--worker",
                            "--model",model,"--repeats",str(args.repeats),"--output-dir",str(output)],
                           cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
    metadata["background_gpu_after_used_mib"] = round(nv.nvmlDeviceGetMemoryInfo(handle).used/2**20,2)
    metadata["background_gpu_after_util_pct"] = nv.nvmlDeviceGetUtilizationRates(handle).gpu
    metadata["background_gpu_after_board_power_w"] = round(nv.nvmlDeviceGetPowerUsage(handle)/1000,3)
    write_json(output/"method.json",dict(repeats=args.repeats,request=job,modes=MODES,metadata=metadata,
               v5_request_overrides={"sample_steps":4,"cfg_rate":0.0}))
    aggregate(output, models, job, args.repeats, metadata)


if __name__=="__main__":
    main()
