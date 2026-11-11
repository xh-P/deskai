"""Keep one Qwen model and reuse Amadeus's prepared decoder when available."""
import inspect
import json
import sys
import time
from pathlib import Path


class QwenEngine:
    def __init__(self, model_id, device, *, engine="cuda_graph", flashAttention=True, graphCapacity=512):
        started = time.perf_counter()
        import torch
        from qwen_asr import Qwen3ASRModel

        manifest = json.loads(Path(__file__).with_name("amadeus-runtime.json").read_text(encoding="utf-8"))
        revision = manifest["revision"]
        bundle = Path(__file__).resolve().parents[2] / ".cache" / "amadeus-qwen" / revision
        self.torch = torch
        self.requested_engine = engine
        self.measured = None
        self.unavailable = None
        kwargs = {}
        if (bundle / ".ready").is_file():
            sys.path.insert(0, str(bundle))
            from asr import qwen_inference
            from asr.qwen_cuda_graph import prepare_qwen_cuda_graphs, qwen_cuda_graph_support_reason

            self.measured = qwen_inference
            attention = qwen_inference.qwen_loader_attention(device, flash_attn_enabled=flashAttention)
            kwargs["attn_implementation"] = attention
        else:
            self.unavailable = "amadeus_runtime_missing"

        # Keep the original model precision and token limit for comparable transcripts.
        self.wrapper = Qwen3ASRModel.from_pretrained(
            model_id, dtype=torch.float32 if device == "cpu" else torch.float16,
            device_map=device, max_inference_batch_size=1, max_new_tokens=256, **kwargs,
        )
        graph = {}
        actual_attention = {}
        if self.measured:
            qwen_inference.apply_qwen_attention_policy(self.wrapper.model, attention)
            actual_attention = qwen_inference.qwen_attention_configs(self.wrapper.model)
            if engine == "cuda_graph":
                reason = qwen_cuda_graph_support_reason(self.wrapper.model)
                if reason is None and "custom_generate" not in inspect.signature(self.wrapper.model.thinker.generate).parameters:
                    reason = "custom_generate_unavailable"
                    self.unavailable = reason
                graph = {"reason": reason} if reason else prepare_qwen_cuda_graphs(
                    self.wrapper.model, (graphCapacity,), capture_allowed=True,
                )
        self.startup = {
            "requestedEngine": engine,
            "sourceRevision": revision if self.measured else None,
            "device": str(self.wrapper.model.device),
            "attention": actual_attention,
            "preparedCapacities": graph.get("prepared_capacities", []),
            "fallbackReason": self.unavailable or graph.get("reason"),
            "graphWarmupMs": sum(bucket["warmup_ms"] for bucket in graph.get("buckets", [])),
            "graphCaptureMs": sum(bucket["capture_ms"] for bucket in graph.get("buckets", [])),
            "graphAllocatedBytes": sum(bucket["allocated_delta_bytes"] for bucket in graph.get("buckets", [])),
            "loadMs": round((time.perf_counter() - started) * 1000, 2),
        }

    def transcribe(self, audio, rate, *, engine=None):
        requested = engine or self.requested_engine
        started = time.perf_counter()
        if self.measured is None:
            with self.torch.inference_mode():
                results = self.wrapper.transcribe(audio=(audio, rate), language=None)
            metrics = {
                "engine": "official",
                "fallbackReason": self.unavailable if requested == "cuda_graph" else None,
                "inferenceMs": round((time.perf_counter() - started) * 1000, 2),
                "replaySteps": 0,
            }
        else:
            selected = "official" if self.unavailable else requested
            results, raw = self.measured.transcribe_qwen(
                self.wrapper, audio, rate, "", None, self.wrapper.max_new_tokens,
                engine=selected,
            )
            graph_requests = raw["graph"]
            metrics = {
                "engine": raw["engine"],
                "fallbackReason": (self.unavailable or next(
                    (row["fallback_reason"] for row in graph_requests if row["fallback_reason"]), None,
                )) if requested == "cuda_graph" else None,
                "inferenceMs": round(raw["inference_wall_ms"], 2),
                "replaySteps": sum(row["replay_steps"] for row in graph_requests),
                "timingMs": {key: round(value, 2) for key, value in raw["wall_ms"].items()},
            }
        metrics.update(requestedEngine=requested, audioMs=round(len(audio) / rate * 1000, 2))
        return (results[0].text if results else "").strip(), metrics
