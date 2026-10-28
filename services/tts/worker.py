"""M0 v2 TTS service: authenticated loopback WS, one inference thread.

Control JSON and binary PCM use the same authenticated connection. A PCM frame
is uint32le header length + UTF-8 JSON header + PCM16LE. No microphone data or
credentials are logged. This is an interface probe, not the complete desktop app.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
from dataclasses import dataclass, field
import hmac
import json
import os
from pathlib import Path
import struct
import sys
import threading
import time

from voices import DEFAULT_VOICE, ROOT, load_registry

PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr  # third-party progress must never enter the control channel
MAX_TEXT = 600
MAX_AUDIO_SECONDS = 30
IDENTITY_KEYS = ("sessionId", "turnId", "generationId", "voiceRevision", "segmentId")


def activate_runtime() -> None:
    repo = ROOT / "runtime/GPT-SoVITS"
    env = ROOT / ".conda/gsv-v5"
    for path in reversed([repo, repo / "GPT_SoVITS", repo / "GPT_SoVITS/BigVGAN"]):
        sys.path.insert(0, str(path))
    dll_paths = [ROOT / "runtime/ffmpeg/bin", env, env / "Scripts", env / "Library/bin", env / "Lib/site-packages/torch/lib"]
    os.environ["PATH"] = os.pathsep.join(map(str, dll_paths)) + os.pathsep + os.environ.get("PATH", "")
    # Do not call gsv_v5/common.activate: it mutates the v5 training project.
    for key in list(os.environ):
        if key.startswith("GSV_"):
            del os.environ[key]
    os.environ.update(version="v2", hz="25hz", PYTHONUTF8="1", OMP_NUM_THREADS="4",
                      TOKENIZERS_PARALLELISM="false", HF_HOME=str(ROOT / ".cache/huggingface"),
                      TORCH_HOME=str(ROOT / ".cache/torch"), NLTK_DATA=str(ROOT / ".cache/nltk_data"), G2PW="0")
    os.chdir(repo)
    from tools.portable_runtime import activate
    activate(change_cwd=True)


@dataclass
class Job:
    request_id: str
    identity: dict
    canceled: threading.Event = field(default_factory=threading.Event)


def validate_synthesis(message: dict) -> dict:
    if message.get("voiceId") != DEFAULT_VOICE:
        raise ValueError("M0 worker only loads the default v2 voice")
    if not isinstance(message.get("text"), str) or not 1 <= len(message["text"].strip()) <= MAX_TEXT:
        raise ValueError("Text must contain 1..600 characters")
    if message.get("language") not in ("all_zh", "all_ja", "en"):
        raise ValueError("Unsupported language route")
    identity = {key: message.get(key) for key in IDENTITY_KEYS}
    for key in ("sessionId", "turnId", "segmentId"):
        if not isinstance(identity[key], str) or not 1 <= len(identity[key]) <= 128:
            raise ValueError("Missing or invalid identity")
    for key in ("generationId", "voiceRevision"):
        if type(identity[key]) is not int or not 0 <= identity[key] <= 2**53 - 1:
            raise ValueError("Missing or invalid revision")
    return identity


def pack_pcm(header: dict, pcm: bytes) -> bytes:
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(encoded)) + encoded + pcm


class Service:
    def __init__(self, state_dir: Path):
        self.state_dir = state_dir
        self.pipeline = None
        self.voice = None
        self.job = None
        self.task = None
        self.owner = None
        self.stop = asyncio.Event()
        self.load_error = None
        self.load_seconds = None

    def load(self) -> None:
        started = time.perf_counter()
        activate_runtime()
        import torch
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA_UNAVAILABLE")
        torch.set_num_threads(4)
        self.voice = load_registry()[DEFAULT_VOICE]
        pretrained = ROOT / "runtime/GPT-SoVITS/GPT_SoVITS/pretrained_models"
        config = dict(version="v2", device="cuda", is_half=True,
                      t2s_weights_path=str(self.voice["gpt"]), vits_weights_path=str(self.voice["sovits"]),
                      bert_base_path=str(pretrained / "chinese-roberta-wwm-ext-large"),
                      cnhuhbert_base_path=str(pretrained / "chinese-hubert-base"))
        for key in ("t2s_weights_path", "vits_weights_path", "bert_base_path", "cnhuhbert_base_path"):
            if not Path(config[key]).exists():
                raise RuntimeError("RESOURCE_MISSING")
        self.state_dir.mkdir(parents=True, exist_ok=True)
        settings = TTS_Config({"custom": config})
        settings.configs_path = str(self.state_dir / "inference-v2.yaml")
        pipeline = TTS(settings)
        if pipeline.configs.version != "v2" or str(pipeline.configs.device) != "cuda":
            raise RuntimeError("INCORRECT_MODEL_VERSION_OR_DEVICE")
        self.pipeline = pipeline
        self.load_seconds = round(time.perf_counter() - started, 3)

    def status(self) -> dict:
        return dict(state="error" if self.load_error else "ready" if self.pipeline else "loading",
                    version="v2", voiceId=DEFAULT_VOICE, loadSeconds=self.load_seconds,
                    busy=self.job is not None, error=self.load_error)

    async def send(self, ws, message):
        await asyncio.wait_for(ws.send(json.dumps(message, separators=(",", ":"))), timeout=5)

    async def emit_pcm(self, ws, job, header, pcm):
        if not job.canceled.is_set():
            await asyncio.wait_for(ws.send(pack_pcm(header, pcm)), timeout=5)

    def synthesize(self, message, job, ws, loop) -> dict:
        import numpy as np
        import torch
        ref = self.voice["references"][0]
        if not ref["name"].startswith("01_") or "平静" not in ref["name"]:
            raise RuntimeError("DEFAULT_REFERENCE_MISMATCH")
        request = dict(text=message["text"], text_lang=message["language"],
                       ref_audio_path=str(ref["path"]), prompt_text=ref["text"], prompt_lang="all_ja",
                       text_split_method="cut0", batch_size=1, split_bucket=False,
                       parallel_infer=True, use_cuda_graph=True, use_flash_attention=False,
                       streaming_mode=False, fragment_interval=0.0, speed_factor=1.0,
                       top_k=15, top_p=1.0, temperature=1.0, seed=1234, repetition_penalty=1.35)
        started = time.perf_counter()
        if job.canceled.is_set():
            return dict(chunks=0, samples=0, canceled=True)
        iterator = self.pipeline.run(request)
        chunks, samples, first_pcm = 0, 0, None
        torch.cuda.reset_peak_memory_stats()
        try:
            for sample_rate, audio in iterator:
                if job.canceled.is_set():
                    break
                if audio.ndim != 1 or audio.dtype != np.int16 or not np.isfinite(audio).all() or not np.any(audio):
                    raise RuntimeError("INVALID_OR_SILENT_PCM")
                samples += len(audio)
                if sample_rate != 32000 or samples > sample_rate * MAX_AUDIO_SECONDS:
                    raise RuntimeError("PCM_RATE_OR_DURATION_LIMIT")
                first_pcm = first_pcm or time.perf_counter()
                header = dict(v=1, event="audio.chunk", requestId=job.request_id, **job.identity,
                              chunkSeq=chunks, sampleRate=sample_rate, channels=1, format="pcm_s16le",
                              samples=len(audio))
                future = asyncio.run_coroutine_threadsafe(
                    self.emit_pcm(ws, job, header, audio.astype("<i2", copy=False).tobytes()), loop)
                future.result(timeout=6)
                chunks += 1
        finally:
            iterator.close()
        torch.cuda.synchronize()
        if not job.canceled.is_set() and chunks == 0:
            raise RuntimeError("NO_PCM")
        return dict(chunks=chunks, samples=samples, canceled=job.canceled.is_set(),
                    firstPCMSeconds=round(first_pcm - started, 3) if first_pcm else None,
                    elapsedSeconds=round(time.perf_counter() - started, 3),
                    peakAllocatedMiB=round(torch.cuda.max_memory_allocated() / 2**20))

    async def run_job(self, ws, message, job):
        try:
            result = await asyncio.to_thread(self.synthesize, message, job, ws, asyncio.get_running_loop())
            await self.send(ws, dict(v=1, event="synthesis.completed", requestId=job.request_id,
                                     **job.identity, **result))
        except Exception as exc:
            # Do not expose arbitrary third-party exception strings or supplied text.
            with contextlib.suppress(Exception):
                await self.send(ws, dict(v=1, event="synthesis.failed", requestId=job.request_id,
                                         code=type(exc).__name__, canceled=job.canceled.is_set()))
        finally:
            self.job = None

    async def handler(self, ws, _path):
        try:
            first = json.loads(await asyncio.wait_for(ws.recv(), 5))
            supplied = first.get("token", "") if isinstance(first, dict) else ""
            token = os.environ["DESKAI_TTS_TOKEN"]
            if not isinstance(supplied, str) or not hmac.compare_digest(supplied, token):
                await ws.close(1008, "Authentication required")
                return
            if self.owner is not None:
                await ws.close(1008, "Worker already owned")
                return
            self.owner = ws
            await self.send(ws, dict(v=1, event="authenticated", **self.status()))
            async for raw in ws:
                try:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise ValueError("Expected object")
                    request_id = message.get("requestId")
                    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
                        raise ValueError("Invalid request ID")
                    op = message.get("op")
                    if op in ("status", "ping"):
                        await self.send(ws, dict(v=1, event="status", requestId=request_id, **self.status()))
                    elif op == "synthesize":
                        identity = validate_synthesis(message)
                        if self.job is not None or self.pipeline is None:
                            await self.send(ws, dict(v=1, event="rejected", requestId=request_id, code="BUSY_OR_NOT_READY"))
                            continue
                        job = Job(request_id, identity)
                        self.job = job
                        await self.send(ws, dict(v=1, event="synthesis.accepted", requestId=request_id, **identity))
                        self.task = asyncio.create_task(self.run_job(ws, message, job))
                    elif op == "cancel":
                        target = message.get("targetRequestId")
                        matched = self.job is not None and self.job.request_id == target
                        if matched:
                            self.job.canceled.set()
                            self.pipeline.stop()
                        await self.send(ws, dict(v=1, event="cancel.accepted", requestId=request_id,
                                                 targetRequestId=target, matched=matched))
                    elif op == "shutdown":
                        await self.send(ws, dict(v=1, event="shutdown.accepted", requestId=request_id))
                        self.stop.set()
                        break
                    else:
                        raise ValueError("Unknown operation")
                except (ValueError, TypeError, KeyError, UnicodeError):
                    await self.send(ws, dict(v=1, event="rejected", code="INVALID_REQUEST"))
        except Exception:
            pass
        finally:
            if self.owner is ws:
                if self.job:
                    self.job.canceled.set()
                    self.pipeline.stop()
                if self.task:
                    with contextlib.suppress(Exception):
                        await self.task
                self.owner = None


async def serve(state_dir: Path):
    import websockets
    token = os.environ.get("DESKAI_TTS_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("DESKAI_TTS_TOKEN must contain at least 32 characters")
    service = Service(state_dir)
    async with websockets.serve(service.handler, "127.0.0.1", 0, max_size=16384, max_queue=4,
                                write_limit=65536, compression=None) as server:
        print(json.dumps(dict(v=1, event="listening", host="127.0.0.1", port=server.sockets[0].getsockname()[1])),
              file=PROTOCOL_OUT, flush=True)
        try:
            await asyncio.to_thread(service.load)
        except Exception as exc:
            service.load_error = type(exc).__name__
            print("TTS_LOAD_ERROR " + type(exc).__name__, file=sys.stderr, flush=True)
        await service.stop.wait()
        if service.job:
            service.job.canceled.set()
            service.pipeline.stop()
        if service.task:
            with contextlib.suppress(Exception):
                await service.task


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=Path, required=True)
    arguments = parser.parse_args()
    asyncio.run(serve(arguments.state_dir.resolve()))
