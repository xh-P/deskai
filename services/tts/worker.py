"""v2 TTS service: authenticated loopback WS, one serialized GPU executor.

Control JSON and binary PCM use the same authenticated connection. A PCM frame
is uint32le header length + UTF-8 JSON header + PCM16LE. No microphone data or
credentials are logged. Weight pairs are unavailable until reference warmup succeeds.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import hmac
import json
import os
from pathlib import Path
import struct
import sys
import threading
import time

from voices import DEFAULT_VOICE, ROOT, load_registry, public_registry, select_reference, VOICE_IDS

PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr  # third-party progress must never enter the control channel
MAX_TEXT = 600
MAX_AUDIO_SECONDS = 30
IDENTITY_KEYS = ("sessionId", "turnId", "generationId", "voiceRevision", "segmentId")


def error_code(exc):
    if isinstance(exc, MemoryError) or "OutOfMemory" in type(exc).__name__:
        return "CUDA_OUT_OF_MEMORY"
    if isinstance(exc, FileNotFoundError):
        return "RESOURCE_MISSING"
    if str(exc) in ("CUDA_UNAVAILABLE", "RESOURCE_MISSING", "INCORRECT_MODEL_VERSION_OR_DEVICE"):
        return str(exc)
    return type(exc).__name__


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
    if message.get("voiceId") not in VOICE_IDS.values():
        raise ValueError("Unknown v2 voice")
    speed = message.get("speed", 1.0)
    if type(speed) not in (int, float) or not 0.5 <= speed <= 2.0:
        raise ValueError("Speed must be 0.5..2.0")
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
        self.registry = load_registry()
        self.reference = None
        self.revision = 0
        self.state = "loading"
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts-gpu")

    async def gpu(self, operation, *args):
        return await asyncio.get_running_loop().run_in_executor(self.executor, operation, *args)

    def load(self) -> None:
        started = time.perf_counter()
        activate_runtime()
        import torch
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA_UNAVAILABLE")
        torch.set_num_threads(4)
        self.voice = self.registry[DEFAULT_VOICE]
        self.reference = select_reference(self.voice)
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
        self.state = "warming"
        self.warmup()
        self.state = "ready"
        self.load_seconds = round(time.perf_counter() - started, 3)

    def status(self) -> dict:
        return dict(state="error" if self.load_error else self.state,
                    version="v2", voiceId=self.voice["id"] if self.voice else DEFAULT_VOICE,
                    referenceId=self.reference["id"] if self.reference else None, voiceRevision=self.revision,
                    loadSeconds=self.load_seconds,
                    busy=self.job is not None, error=self.load_error)

    def inference_request(self, message) -> dict:
        ref = self.reference
        return dict(text=message["text"], text_lang=message["language"],
                    ref_audio_path=str(ref["path"]), prompt_text=ref["text"], prompt_lang="all_ja",
                    text_split_method="cut0", batch_size=1, split_bucket=False,
                    parallel_infer=True, use_cuda_graph=True, use_flash_attention=False,
                    streaming_mode=False, fragment_interval=0.0, speed_factor=message.get("speed", 1.0),
                    top_k=15, top_p=1.0, temperature=1.0, seed=1234, repetition_penalty=1.35)

    def warmup(self):
        import numpy as np
        iterator = self.pipeline.run(self.inference_request(dict(text="こんにちは。", language="all_ja")))
        valid = False
        try:
            for rate, audio in iterator:
                if rate not in (32000, 48000) or audio.ndim != 1 or audio.dtype != np.int16 or not np.any(audio):
                    raise RuntimeError("INVALID_WARMUP_PCM")
                valid = True
        finally:
            iterator.close()
        if not valid:
            raise RuntimeError("NO_WARMUP_PCM")

    def load_pair(self, voice, reference):
        import gc
        import torch
        # Free the previous pair before loading another pair on an 8 GiB GPU.
        # init_t2s_weights closes the previous CUDA graph accelerator itself.
        self.pipeline.t2s_model = None
        self.pipeline.vits_model = None
        gc.collect()
        torch.cuda.empty_cache()
        self.pipeline.init_t2s_weights(str(voice["gpt"]))
        self.pipeline.init_vits_weights(str(voice["sovits"]))
        if self.pipeline.configs.version != "v2":
            raise RuntimeError("INCORRECT_MODEL_VERSION")
        self.pipeline.prompt_cache.update(ref_audio_path=None, prompt_semantic=None, refer_spec=[],
                                         prompt_text=None, prompt_lang=None, phones=None,
                                         bert_features=None, norm_text=None, aux_ref_audio_paths=[])
        self.voice, self.reference = voice, reference

    def switch(self, voice, reference):
        previous_voice, previous_ref = self.voice, self.reference
        try:
            if voice["id"] != previous_voice["id"]:
                self.load_pair(voice, reference)
            else:
                self.reference = reference
            self.warmup()
        except Exception:
            try:
                self.load_pair(previous_voice, previous_ref)
                self.warmup()
            except Exception:
                self.load_error = "ROLLBACK_FAILED"
            raise
        self.revision += 1

    async def run_switch(self, ws, request_id, voice, reference):
        try:
            await self.gpu(self.switch, voice, reference)
            self.state = "ready"
            await self.send(ws, dict(v=1, event="voice.selected", requestId=request_id, **self.status()))
        except Exception as exc:
            self.state = "error" if self.load_error else "ready"
            with contextlib.suppress(Exception):
                await self.send(ws, dict(v=1, event="voice.failed", requestId=request_id,
                                         code=self.load_error or error_code(exc), **self.status()))

    async def send(self, ws, message):
        await asyncio.wait_for(ws.send(json.dumps(message, separators=(",", ":"))), timeout=5)

    async def emit_pcm(self, ws, job, header, pcm):
        if not job.canceled.is_set():
            await asyncio.wait_for(ws.send(pack_pcm(header, pcm)), timeout=5)

    def synthesize(self, message, job, ws, loop) -> dict:
        import numpy as np
        import torch
        request = self.inference_request(message)
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
                if sample_rate not in (32000, 48000) or samples > sample_rate * MAX_AUDIO_SECONDS:
                    raise RuntimeError("PCM_RATE_OR_DURATION_LIMIT")
                first_pcm = first_pcm or time.perf_counter()
                header = dict(v=1, event="audio.chunk", requestId=job.request_id, **job.identity,
                              voiceId=self.voice["id"], referenceId=self.reference["id"],
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
            result = await self.gpu(self.synthesize, message, job, ws, asyncio.get_running_loop())
            if self.job is job:
                self.job = None
            await self.send(ws, dict(v=1, event="synthesis.completed", requestId=job.request_id,
                                     **job.identity, **result))
        except Exception as exc:
            if self.job is job:
                self.job = None
            # Do not expose arbitrary third-party exception strings or supplied text.
            with contextlib.suppress(Exception):
                await self.send(ws, dict(v=1, event="synthesis.failed", requestId=job.request_id,
                                         **job.identity, code=error_code(exc), canceled=job.canceled.is_set()))
        finally:
            if self.job is job:
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
                message = None
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
                    elif op == "registry":
                        await self.send(ws, dict(v=1, event="registry", requestId=request_id,
                                                 voices=public_registry(self.registry)))
                    elif op == "selectVoice":
                        voice = self.registry.get(message.get("voiceId"))
                        if voice is None:
                            raise ValueError("Unknown voice")
                        reference = select_reference(voice, message.get("referenceId"))
                        if self.job is not None or self.state != "ready" or self.load_error:
                            await self.send(ws, dict(v=1, event="rejected", requestId=request_id, code="BUSY_OR_NOT_READY"))
                            continue
                        if voice is self.voice and reference is self.reference:
                            await self.send(ws, dict(v=1, event="voice.selected", requestId=request_id, **self.status()))
                            continue
                        self.state = "switching"
                        await self.send(ws, dict(v=1, event="voice.switching", requestId=request_id, **self.status()))
                        self.task = asyncio.create_task(self.run_switch(ws, request_id, voice, reference))
                    elif op == "synthesize":
                        identity = validate_synthesis(message)
                        if self.job is not None or self.pipeline is None or self.state != "ready" or self.load_error:
                            await self.send(ws, dict(v=1, event="rejected", requestId=request_id, code="BUSY_OR_NOT_READY"))
                            continue
                        reference = select_reference(self.voice, message.get("referenceId"))
                        if (message["voiceId"] != self.voice["id"] or reference is not self.reference
                                or message["voiceRevision"] != self.revision):
                            await self.send(ws, dict(v=1, event="rejected", requestId=request_id, code="STALE_VOICE_SELECTION"))
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
                    await self.send(ws, dict(v=1, event="rejected", requestId=message.get("requestId")
                                             if isinstance(message, dict) else None, code="INVALID_REQUEST"))
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
                # One authenticated owner for this worker lifetime. A crashed
                # parent must not leave an idle CUDA process behind.
                self.stop.set()


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
            await service.gpu(service.load)
        except Exception as exc:
            service.load_error = error_code(exc)
            print("TTS_LOAD_ERROR " + service.load_error, file=sys.stderr, flush=True)
        await service.stop.wait()
        if service.job:
            service.job.canceled.set()
            service.pipeline.stop()
        if service.task:
            with contextlib.suppress(Exception):
                await service.task
    service.executor.shutdown(wait=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=Path, required=True)
    arguments = parser.parse_args()
    asyncio.run(serve(arguments.state_dir.resolve()))
