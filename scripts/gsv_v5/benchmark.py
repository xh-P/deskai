"""Single-user resident TTS latency/resource checks, with raw per-request evidence."""
from __future__ import annotations

import argparse
import gc
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import threading
import time
import traceback

PROCESS_START = time.perf_counter()
from common import ENV, REPO, ROOT, activate, write_json

MODES = {
    "full_baseline": dict(streaming_mode=False, parallel_infer=True, use_cuda_graph=False),
    "full_cuda_graph": dict(streaming_mode=False, parallel_infer=True, use_cuda_graph=True),
    "sentence_cuda_graph": dict(streaming_mode=False, return_fragment=True, text_split_method="cut5",
                                parallel_infer=True, use_cuda_graph=True, split_bucket=False),
    "v2_fixed_stream": dict(streaming_mode=True, gpt_streaming=False, parallel_infer=False,
                            fixed_length_chunk=True, min_chunk_length=16, overlap_length=2,
                            use_cuda_graph=False, split_bucket=False),
    "v5_semantic_stream": dict(streaming_mode=3, gpt_streaming=True, parallel_infer=False,
                               streaming_chunk_seconds=0.5, streaming_window_mode="fixed",
                               streaming_lookahead_seconds=0.12, streaming_overlap_seconds=0.04,
                               gpt_streaming_lookahead_seconds=0.5, min_chunk_length=16,
                               use_cuda_graph=True, split_bucket=False),
}


class ResourceSampler:
    def __init__(self):
        import psutil
        import pynvml as nv
        self.ps = psutil.Process()
        self.nv = nv
        nv.nvmlInit()
        self.gpu = nv.nvmlDeviceGetHandleByIndex(0)
        self.records = []
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def sample(self):
        nv = self.nv
        row = dict(time=time.perf_counter(), rss_mib=self.ps.memory_info().rss / 2**20)
        for key, getter in {
            "gpu_total_used_mib": lambda: nv.nvmlDeviceGetMemoryInfo(self.gpu).used / 2**20,
            "gpu_util_pct": lambda: nv.nvmlDeviceGetUtilizationRates(self.gpu).gpu,
            "gpu_board_power_w": lambda: nv.nvmlDeviceGetPowerUsage(self.gpu) / 1000,
            "gpu_temperature_c": lambda: nv.nvmlDeviceGetTemperature(self.gpu, nv.NVML_TEMPERATURE_GPU),
        }.items():
            try:
                row[key] = getter()
            except nv.NVMLError:
                pass
        self.records.append(row)

    def loop(self):
        while not self.stop_event.is_set():
            self.sample()
            self.stop_event.wait(0.05)

    def start(self):
        self.thread.start()

    def summary(self, start, end):
        rows = [r for r in self.records if start <= r["time"] <= end]
        result = dict(samples=len(rows))
        for key in ("rss_mib", "gpu_total_used_mib", "gpu_util_pct", "gpu_board_power_w", "gpu_temperature_c"):
            values = [r[key] for r in rows if key in r]
            if values:
                result[key + "_mean"] = round(statistics.mean(values), 3)
                result[key + "_peak"] = round(max(values), 3)
        return result

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=3)


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
    torch.set_num_threads(4)
    sampler = ResourceSampler()
    sampler.start()
    tts_config = TTS_Config({"custom": config})
    tts_config.configs_path = str(output / (args.model + ".yaml"))
    torch.cuda.reset_peak_memory_stats()
    before_load = time.perf_counter()
    pipeline = TTS(tts_config)
    torch.cuda.synchronize()
    ready_at = time.perf_counter()
    report = dict(model=args.model, version=config["version"],
                  model_load_seconds=round(ready_at - before_load, 4),
                  process_to_models_ready_seconds=round(ready_at - PROCESS_START, 4),
                  load_peak_allocated_mib=round(torch.cuda.max_memory_allocated() / 2**20, 2),
                  loaded_allocated_mib=round(torch.cuda.memory_allocated() / 2**20, 2),
                  loaded_rss_mib=round(psutil.Process().memory_info().rss / 2**20, 2),
                  load_resources=sampler.summary(before_load, ready_at), samples=[], failures=[])
    result_path = output / (args.model + ".json")
    write_json(result_path, report)

    def measure(mode, text, phase, repeat):
        request = dict(job["parameters"], text=text["text"], text_lang=text["language"],
                       ref_audio_path=job["reference"], prompt_text=job["prompt_text"],
                       prompt_lang=job["prompt_language"], **{})
        request.update(MODES[mode])
        if args.model == "v5_base":
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
        # Simulated immediate playback: negative slack means it would need buffering.
        queued = 0.0
        slack = []
        for arrival in arrivals:
            if queued:
                slack.append(first_pcm + queued - arrival["at_seconds"])
            queued += arrival["duration_seconds"]
        active_accel = pipeline.streaming_accel if mode == "v5_semantic_stream" else pipeline.t2s_accel
        cpu_seconds = after_cpu.user + after_cpu.system - before_cpu.user - before_cpu.system
        row = dict(mode=mode, language=text["id"], phase=phase, repeat=repeat,
                   text=text["text"], seed=request["seed"], duration_seconds=round(duration, 4),
                   total_seconds=round(end-start, 4), first_pcm_seconds=round(first_pcm, 4),
                   rtf=round((end-start)/duration, 4), chunks=len(chunks),
                   first_chunk_duration_seconds=round(arrivals[0]["duration_seconds"], 4),
                   playback_min_slack_seconds=round(min(slack), 4) if slack else None,
                   cpu_core_equivalents=round(cpu_seconds/(end-start), 3),
                   allocated_peak_mib=round(torch.cuda.max_memory_allocated()/2**20, 2),
                   reserved_peak_mib=round(torch.cuda.max_memory_reserved()/2**20, 2),
                   acceleration_backend=getattr(active_accel, "backend", None),
                   cuda_graph_active=bool(getattr(active_accel, "graph_enabled", False)),
                   resources=sampler.summary(start,end), arrivals=arrivals)
        if repeat == 0 and phase == "warm":
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
                measure(mode,job["texts"][0],"first_call" if mode=="full_baseline" else "mode_setup",-1)
                for text in job["texts"]:
                    for repeat in range(args.repeats):
                        measure(mode,text,"warm",repeat)
            except Exception as exc:
                traceback.print_exc()
                report["failures"].append(dict(mode=mode,error=str(exc)))
                write_json(result_path,report)
    finally:
        sampler.stop()
        write_json(output/(args.model+".resources.json"),dict(samples=sampler.records))
    report["complete"] = True
    write_json(result_path,report)


def main():
    activate()
    parser=argparse.ArgumentParser()
    parser.add_argument("--model",choices=["all","v2_tuned","v5_base"],default="all")
    parser.add_argument("--repeats",type=int,default=3)
    parser.add_argument("--output-dir",type=Path,required=True)
    parser.add_argument("--worker",action="store_true")
    args=parser.parse_args()
    output=args.output_dir.resolve()
    output.mkdir(parents=True,exist_ok=True)
    job=json.loads((ROOT/"outputs/nagato_audition/20261023-ab/comparison.json").read_text(encoding="utf-8"))
    if args.worker:
        worker(args,output,job)
        return
    write_json(output/"method.json",dict(repeats=args.repeats,request=job,modes=MODES,
              note="One request at a time. Fixed seed. Warm reference cache. 50 ms resource sampling. No network or playback device. GPU board readings include other applications. Windows file cache not cleared. FlashAttention disabled; PyTorch CUDA Graph tested separately."))
    for model in (["v2_tuned","v5_base"] if args.model=="all" else [args.model]):
        if (output/(model+".json")).exists():
            raise FileExistsError(f"Preserve existing benchmark: {model}")
        with (output/(model+".log")).open("w",encoding="utf-8") as log:
            print(f"Benchmarking {model}: {output}",flush=True)
            subprocess.run([str(ENV/"python.exe"),"-u",str(Path(__file__).resolve()),"--worker",
                            "--model",model,"--repeats",str(args.repeats),"--output-dir",str(output)],
                           cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)


if __name__=="__main__":
    main()
