"""Run the actual default-v2 GPU/WS/cancellation M0 checks; never train."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import struct
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/tts"))
from voices import DEFAULT_VOICE, load_registry


def receive(ws, timeout=90):
    message = ws.recv(timeout=timeout)
    if isinstance(message, bytes):
        if len(message) < 4:
            raise AssertionError("Truncated PCM header")
        length = struct.unpack("<I", message[:4])[0]
        header = json.loads(message[4:4 + length])
        return header, message[4 + length:]
    return json.loads(message), None


def until(ws, event, request_id=None, timeout=120):
    deadline = time.monotonic() + timeout
    events = []
    while time.monotonic() < deadline:
        header, pcm = receive(ws, min(90, deadline - time.monotonic()))
        events.append((header, pcm))
        if header.get("event") == "synthesis.failed":
            raise RuntimeError("Worker synthesis failed: " + header.get("code", "unknown"))
        if header.get("event") == event and (request_id is None or header.get("requestId") == request_id):
            return events
    raise TimeoutError(event)


def request(request_id, **changes):
    return dict(v=1, op="synthesize", requestId=request_id, voiceId=DEFAULT_VOICE,
                text="你好。我在这里。", language="all_zh", sessionId="m0-tts", turnId=request_id,
                generationId=1, voiceRevision=0, segmentId="sentence-1", **changes)


def main():
    from websockets.sync.client import connect
    from websockets.exceptions import ConnectionClosed
    import numpy as np
    import soundfile as sf
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs/desktop-validation/m0/tts")
    args = parser.parse_args()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(32)
    report = dict(timestampUTC=datetime.now(timezone.utc).isoformat(), protocolVersion=1,
                  version="v2", defaultVoiceId=DEFAULT_VOICE, trainingPerformed=False,
                  subjectiveListeningPerformed=False, microphoneTested=False, speakerAECTested=False,
                  parameters=dict(batch_size=1, is_half=True, use_cuda_graph=True,
                                  text_split_method="cut0", fragment_interval=0.0), checks={})
    registry = load_registry()
    report["resources"] = [dict(id=voice["id"], version="v2", name=voice["name"],
                                gpt=str(voice["gpt"].relative_to(ROOT)).replace("\\", "/"),
                                sovits=str(voice["sovits"].relative_to(ROOT)).replace("\\", "/"),
                                references=len(voice["references"])) for voice in registry.values()]
    report["checks"]["tenVoiceResourcesExist"] = len(registry) == 10
    log_path = output / "worker.log"
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen([str(ROOT / ".conda/gsv-v5/python.exe"), "-u",
                                    str(ROOT / "services/tts/worker.py"), "--state-dir", str(output / "state")],
                                   cwd=ROOT, env={**os.environ, "DESKAI_TTS_TOKEN": token,
                                                  "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
                                   stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8")
        ws = None
        try:
            # The worker reports its port before loading CUDA; no token enters stdout.
            endpoint = json.loads(process.stdout.readline())
            assert endpoint["host"] == "127.0.0.1" and endpoint["event"] == "listening"
            url = f"ws://127.0.0.1:{endpoint['port']}"
            with connect(url, open_timeout=10, max_size=4 * 2**20) as unauthorized:
                unauthorized.send(json.dumps(dict(token="incorrect")))
                try:
                    unauthorized.recv(timeout=10)
                    raise AssertionError("Unauthorized connection was accepted")
                except ConnectionClosed as exc:
                    assert exc.code == 1008
                    report["checks"]["authenticationRequired"] = True
            ws = connect(url, open_timeout=10, max_size=4 * 2**20)
            ws.send(json.dumps(dict(v=1, token=token)))
            until(ws, "authenticated")
            deadline = time.monotonic() + 180
            while True:
                ws.send(json.dumps(dict(op="status", requestId="ready")))
                status = until(ws, "status", "ready")[-1][0]
                if status["state"] == "ready":
                    break
                if status["state"] == "error" or time.monotonic() > deadline:
                    raise RuntimeError("Worker load failed: " + str(status.get("error")))
                time.sleep(2)
            report["modelLoadSeconds"] = status["loadSeconds"]
            ws.send(json.dumps(request("normal"), ensure_ascii=False))
            events = until(ws, "synthesis.completed", "normal")
            chunks = []
            sequence = 0
            for header, pcm in events:
                if pcm is None:
                    continue
                assert header["requestId"] == "normal" and header["generationId"] == 1
                assert header["chunkSeq"] == sequence and header["sampleRate"] == 32000
                assert header["format"] == "pcm_s16le" and header["channels"] == 1
                assert len(pcm) == header["samples"] * 2
                chunks.append(np.frombuffer(pcm, dtype="<i2"))
                sequence += 1
            audio = np.concatenate(chunks)
            assert np.any(audio) and len(audio) / 32000 > 0.5
            path = output / "nagato-normal-v2-zh.wav"
            sf.write(path, audio, 32000, subtype="PCM_16")
            report["synthesis"] = dict(**{k: v for k, v in events[-1][0].items() if k not in ("event", "v")},
                                        sampleRate=32000, durationSeconds=round(len(audio) / 32000, 3),
                                        rms=round(float(np.sqrt(np.mean((audio.astype(float) / 32768)**2))), 6),
                                        peak=int(np.abs(audio.astype(np.int32)).max()),
                                        sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            report["checks"]["nonSilentPCMWithIdentity"] = True
            # Cancel during active generation, then prove a subsequent job can run.
            cancel_request = request("to-cancel")
            cancel_request["text"] = "这是一段用于取消握手的测试内容。" * 12
            cancel_request["generationId"] = 2
            ws.send(json.dumps(cancel_request, ensure_ascii=False))
            until(ws, "synthesis.accepted", "to-cancel")
            time.sleep(0.05)
            cancel_started = time.perf_counter()
            ws.send(json.dumps(dict(op="cancel", requestId="cancel", targetRequestId="to-cancel")))
            cancel_events = until(ws, "cancel.accepted", "cancel")
            report["cancelAcceptedMilliseconds"] = round((time.perf_counter() - cancel_started) * 1000, 2)
            assert cancel_events[-1][0]["matched"] is True
            finished = until(ws, "synthesis.completed", "to-cancel")
            assert finished[-1][0]["canceled"] is True
            assert all(pcm is None for _, pcm in finished), "Late canceled PCM reached the connection"
            report["cancelSettledMilliseconds"] = round((time.perf_counter() - cancel_started) * 1000, 2)
            report["checks"]["cancelAcceptedDuringInference"] = True
            report["checks"]["noPCMAfterCancelAcknowledgment"] = True
            recovery = request("recovered")
            recovery["generationId"] = 3
            ws.send(json.dumps(recovery, ensure_ascii=False))
            recovered = until(ws, "synthesis.completed", "recovered")
            assert any(pcm for _, pcm in recovered)
            assert recovered[-1][0]["canceled"] is False
            report["checks"]["synthesisAfterCancellation"] = True
            ws.send(json.dumps(dict(op="shutdown", requestId="shutdown")))
            until(ws, "shutdown.accepted", "shutdown")
            ws.close()
            ws = None
            process.wait(timeout=30)
            report["checks"]["cleanWorkerExit"] = process.returncode == 0
            assert process.returncode == 0
            report["passed"] = True
        except Exception as exc:
            report["passed"] = False
            report["failure"] = type(exc).__name__ + ": " + str(exc)
            raise
        finally:
            if ws is not None:
                ws.close()
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)
            (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(dict(passed=report["passed"], report=str(output / "report.json")), ensure_ascii=False))


if __name__ == "__main__":
    main()
