"""Compare the official and graph decoders on identical cached audio."""
import argparse
import json
import math
import os
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "asr"))
from qwen_engine import QwenEngine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seconds", type=float, default=10)
    args = parser.parse_args()
    if args.repeats < 1 or args.seconds <= 0:
        parser.error("repeats and seconds must be positive")
    os.environ["HF_HUB_OFFLINE"] = "1"
    import soundfile as sf
    from scipy.signal import resample_poly

    config = json.loads((ROOT / "config" / "voice" / "input-runtime.json").read_text(encoding="utf-8"))["conversation"]
    engine = QwenEngine(config["model"], config["device"], **config["inference"])
    rows = []
    for file in args.files:
        audio, rate = sf.read(file, dtype="float32", always_2d=True)
        audio = audio[:int(args.seconds * rate)].mean(axis=1)
        divisor = math.gcd(rate, 16_000)
        audio = resample_poly(audio, 16_000 // divisor, rate // divisor)
        for mode in ("official", "cuda_graph"):
            engine.transcribe(audio, 16_000, engine=mode)
        timings = {"official": [], "cuda_graph": []}
        texts = {"official": [], "cuda_graph": []}
        graph_steps = []
        for index in range(args.repeats):
            modes = ("official", "cuda_graph") if index % 2 == 0 else ("cuda_graph", "official")
            for mode in modes:
                text, metrics = engine.transcribe(audio, 16_000, engine=mode)
                timings[mode].append(metrics["inferenceMs"])
                texts[mode].append(text)
                if mode == "cuda_graph":
                    graph_steps.append(metrics["replaySteps"])
        rows.append({
            "file": file.name, "audioMs": round(len(audio) / 16, 2),
            "officialMedianMs": round(statistics.median(timings["official"]), 2),
            "graphMedianMs": round(statistics.median(timings["cuda_graph"]), 2),
            "graphReplaySteps": graph_steps,
            "sameTranscripts": texts["official"] == texts["cuda_graph"],
            "timingsMs": timings,
        })
    print(json.dumps({"startup": engine.startup, "repeats": args.repeats, "samples": rows}, ensure_ascii=True, indent=2))
    return 0 if all(all(row["graphReplaySteps"]) for row in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
