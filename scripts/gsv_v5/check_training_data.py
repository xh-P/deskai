"""Audit actual upstream datasets; optionally backpropagate extreme real batches.

No optimizer step, checkpoint, or inference weights are written. Reports only go
to checks/real-data-*.json. Run stages sequentially to bound GPU memory use.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import time
import traceback
from pathlib import Path

from common import PROJECT, REPO, activate, write_json


def finite(value, name):
    import torch
    if isinstance(value, torch.Tensor):
        if not value.numel() or not torch.isfinite(value).all():
            raise ValueError(f"Empty or non-finite tensor: {name}")
    elif isinstance(value, dict):
        for key, item in value.items():
            finite(item, f"{name}.{key}")
    elif isinstance(value, (tuple, list)):
        for index, item in enumerate(value):
            finite(item, f"{name}[{index}]")


def datasets(cfg1, cfg2):
    from AR.data.dataset import Text2SemanticDataset
    from module.data_utils import TextAudioSpeakerLoaderV4, DistributedBucketSampler
    from utils import HParams
    s2 = TextAudioSpeakerLoaderV4(HParams(**cfg2["data"]))
    boundaries = [32, 300, 400, 500, 600, 700, 800, 900, 1000]
    sampler = DistributedBucketSampler(s2, 1, boundaries.copy(), num_replicas=1, rank=0, shuffle=True)
    indices = sorted({index for batch in sampler for index in batch})
    if not indices:
        raise ValueError("No SoVITS batches survive the actual bucket sampler")
    s1 = Text2SemanticDataset(phoneme_path=cfg1["train_phoneme_path"],
                             semantic_path=cfg1["train_semantic_path"],
                             max_sec=cfg1["data"]["max_sec"], pad_val=cfg1["data"]["pad_val"])
    if not len(s1):
        raise ValueError("No GPT samples survive the actual dataset")
    return s1, s2, indices, boundaries


def strict_sovits_item(dataset, index):
    """Bypass upstream's silent error fallback, then check its actual returned item."""
    import torch
    name, phones = dataset.audiopaths_sid_text[index]
    ssl = torch.load(Path(dataset.path4) / (name + ".pt"), map_location="cpu", weights_only=True)
    spec, mel = dataset.get_audio(str(Path(dataset.path5) / name))
    finite((ssl, spec, mel), name)
    if ssl.ndim != 3 or ssl.shape[1] != 768 or not phones:
        raise ValueError(f"Invalid SSL/text shape: {name}")
    if spec.shape[-1] - ssl.shape[-1] not in (0, 1):
        raise ValueError(f"Unexpected SSL/spec frame mismatch: {name}")
    actual = dataset[index]
    finite(actual, name + ".actual_item")
    if actual[3].numel() != len(phones) or not torch.equal(actual[1], spec) or not torch.equal(actual[2], mel):
        raise ValueError(f"Actual dataset differs from strict decoding (possible zero fallback): {name}")
    return actual


def audit(cfg1, cfg2, s1, s2, indices, boundaries):
    import torch
    from module.data_utils import TextAudioSpeakerCollateV4
    from text import cleaned_text_to_sequence
    text_rows = {}
    for line in Path(cfg1["train_phoneme_path"]).read_text(encoding="utf-8").splitlines():
        fields = line.split("\t")
        if len(fields) != 4 or fields[0] in text_rows:
            raise ValueError(f"Malformed or duplicate phoneme row: {line[:100]}")
        text_rows[fields[0]] = fields
    semantic_rows = {}
    for line in Path(cfg1["train_semantic_path"]).read_text(encoding="utf-8").splitlines()[1:]:
        name, tokens = line.split("\t")
        if name in semantic_rows:
            raise ValueError(f"Duplicate semantic row: {name}")
        semantic_rows[name] = [int(token) for token in tokens.split()]
        if not semantic_rows[name] or min(semantic_rows[name]) < 0 or max(semantic_rows[name]) >= cfg1["data"]["pad_val"]:
            raise ValueError(f"Invalid semantic token: {name}")
    expected = {line.split("|", 1)[0].replace("\\", "/").rsplit("/", 1)[-1]
                for line in (PROJECT / "train.list").read_text(encoding="utf-8-sig").splitlines() if line.strip()}
    if set(text_rows) != expected or set(semantic_rows) != expected:
        raise ValueError("Preprocessed text/semantic filenames do not exactly match train.list")
    s2_loaded = {row[0] for row in s2.audiopaths_sid_text}
    s2_used = {s2.audiopaths_sid_text[i][0] for i in indices}
    s1_used = set(s1.item_names)
    gpt_filtered = []
    for name in sorted(expected - s1_used):
        reasons = []
        semantic = semantic_rows[name]
        phones = cleaned_text_to_sequence(text_rows[name][1].split(), cfg2["model"]["version"])
        ratio = len(phones) / (len(semantic) / s1.hz)
        if len(semantic) > s1.max_sec * s1.hz:
            reasons.append("semantic_duration_above_max_sec")
        if len(phones) > s1.max_sec * s1.hz / 2.5:
            reasons.append("phoneme_count_above_max_sec_hz_div_2.5")
        if ratio < s1.min_ps_ratio or ratio > s1.max_ps_ratio:
            reasons.append("phonemes_per_second_outside_3_to_25")
        gpt_filtered.append(dict(file=name, semantic_frames=len(semantic), phonemes=len(phones),
                                 phonemes_per_second=ratio, reasons=reasons or ["upstream_dataset_filter"]))
    s2_shapes = []
    collate = TextAudioSpeakerCollateV4()
    for i in range(len(s2)):
        item = strict_sovits_item(s2, i)
        finite(collate([item]), f"sovits.batch.{i}")
        name = s2.audiopaths_sid_text[i][0]
        s2_shapes.append(dict(file=name, index=i, bucket_length=s2.lengths[i],
                              ssl_frames=item[0].shape[-1], spec_frames=item[1].shape[-1],
                              mel_frames=item[2].shape[-1], phonemes=item[3].numel(), sampled=i in indices))
        if (i + 1) % 50 == 0:
            print(f"Strict real SoVITS features: {i + 1}/{len(s2)}", flush=True)
    for i in range(len(s1)):
        finite(s1.collate([s1[i]]), f"gpt.batch.{s1.item_names[i]}")
    # Also check tensors belonging to filtered inputs rather than silently ignoring them.
    feature_root = Path(cfg2["data"]["exp_dir"])
    for folder in ("4-cnhubert", "3-bert"):
        for path in (feature_root / folder).glob("*.pt"):
            finite(torch.load(path, map_location="cpu", weights_only=True), str(path))
    return dict(expected_clips=len(expected), all_features_finite=True,
                sovits=dict(dataset_records=len(s2), sampled_records=len(indices), boundaries=boundaries,
                            included=sorted(s2_used), loader_filtered=sorted(expected - s2_loaded),
                            sampler_filtered=[dict(file=s2.audiopaths_sid_text[i][0], bucket_length=s2.lengths[i],
                                                   reason="outside_(32,1000]_bucket_bounds")
                                              for i in range(len(s2)) if i not in indices], shapes=s2_shapes),
                gpt=dict(dataset_records=len(s1), included=sorted(s1_used), filtered=gpt_filtered,
                         semantic_hz=s1.hz, min_phonemes_per_second=s1.min_ps_ratio,
                         max_phonemes_per_second=s1.max_ps_ratio))


def smoke(stage, cfg1, cfg2, s1, s2, indices):
    import torch
    torch.manual_seed(1234)
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA required for GPU smoke stage")
    if stage == "sovits":
        from module.models import SynthesizerTrnV3
        from module.data_utils import TextAudioSpeakerCollateV4
        from peft import LoraConfig, get_peft_model
        model = SynthesizerTrnV3(cfg2["data"]["filter_length"] // 2 + 1,
                                 cfg2["train"]["segment_size"] // cfg2["data"]["hop_length"],
                                 n_speakers=cfg2["data"]["n_speakers"], **cfg2["model"])
        checkpoint = torch.load(cfg2["train"]["pretrained_s2G"], map_location="cpu", weights_only=False)
        loaded = model.load_state_dict(checkpoint["weight"], strict=False)
        if loaded.missing_keys or loaded.unexpected_keys:
            raise ValueError(str(loaded))
        del checkpoint
        rank = int(cfg2["train"]["lora_rank"])
        model.cfm = get_peft_model(model.cfm, LoraConfig(target_modules=["to_k", "to_q", "to_v", "to_out.0"],
                                  r=rank, lora_alpha=rank, init_lora_weights=True))
        model.cuda().train()
        optimizer = torch.optim.AdamW(filter(lambda p: p.requires_grad, model.parameters()),
                                     cfg2["train"]["learning_rate"], betas=cfg2["train"]["betas"], eps=cfg2["train"]["eps"])
        chosen = sorted({min(indices, key=lambda i: s2.lengths[i]), max(indices, key=lambda i: s2.lengths[i]),
                         max(indices, key=lambda i: len(s2.audiopaths_sid_text[i][1]))})
    else:
        from AR.models.t2s_lightning_module import Text2SemanticLightningModule
        model = Text2SemanticLightningModule(cfg1, PROJECT / "checks", is_train=False)
        checkpoint = torch.load(cfg1["pretrained_s1"], map_location="cpu", weights_only=False)
        model.load_state_dict(checkpoint["weight"], strict=True)
        del checkpoint
        model.cuda().train()
        optimizer = model.configure_optimizers()["optimizer"]
        chosen = sorted({min(range(len(s1)), key=s1.get_sample_length), max(range(len(s1)), key=s1.get_sample_length),
                         max(range(len(s1)), key=lambda i: len(s1.semantic_phoneme[i][1]))})
    gc.collect()
    results = []
    for index in chosen:
        model.zero_grad(set_to_none=True)
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        if stage == "sovits":
            batch = list(TextAudioSpeakerCollateV4()([strict_sovits_item(s2, index)]))
            name = s2.audiopaths_sid_text[index][0]
            batch = [tensor if i == 3 else tensor.cuda() for i, tensor in enumerate(batch)]
            with torch.autocast("cuda", dtype=torch.float16, enabled=cfg2["train"]["fp16_run"]):
                loss = model(*batch, use_grad_ckpt=cfg2["train"]["grad_ckpt"])
        else:
            batch = s1.collate([s1[index]])
            batch = {key: value.cuda() if isinstance(value, torch.Tensor) else value for key, value in batch.items()}
            name = s1.item_names[index]
            forward = model.model.forward if cfg1["train"].get("if_dpo", False) else model.model.forward_old
            with torch.autocast("cuda", dtype=torch.float16):
                loss, _ = forward(batch["phoneme_ids"], batch["phoneme_ids_len"], batch["semantic_ids"],
                                  batch["semantic_ids_len"], batch["bert_feature"])
        finite(loss, name + ".loss")
        loss.backward()
        gradients = [(n, p.grad) for n, p in model.named_parameters() if p.requires_grad and p.grad is not None]
        finite([grad for _, grad in gradients], name + ".gradients")
        selected = [grad for n, grad in gradients if stage == "gpt" or "lora_" in n]
        if not selected or not any(torch.count_nonzero(grad).item() for grad in selected):
            raise ValueError(f"No nonzero {'LoRA ' if stage == 'sovits' else ''}gradients: {name}")
        torch.cuda.synchronize()
        result = dict(file=name, index=index, loss=loss.item(), finite_gradient_tensors=len(gradients),
                      elapsed_seconds=time.perf_counter() - started,
                      peak_allocated_mib=torch.cuda.max_memory_allocated() / 2**20,
                      peak_reserved_mib=torch.cuda.max_memory_reserved() / 2**20)
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        del batch, loss, gradients, selected
    return dict(optimizer=type(optimizer).__name__, optimizer_initialized=True, optimizer_steps=0,
                optimizer_state_allocation_tested=False, weights_saved=False,
                trainable_parameters=sum(p.numel() for p in model.parameters() if p.requires_grad),
                samples=results, note="Unscaled backward, no GradScaler or optimizer step; does not measure optimizer-state peak")


def main():
    activate()
    os.chdir(REPO)
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--data-only", action="store_true")
    mode.add_argument("--stage", choices=["sovits", "gpt"])
    args = parser.parse_args()
    import torch
    import yaml
    torch.set_num_threads(4)
    cfg1_path, cfg2_path = PROJECT / "configs/gpt.yaml", PROJECT / "configs/sovits.json"
    cfg1 = yaml.safe_load(cfg1_path.read_text(encoding="utf-8"))
    cfg2 = json.loads(cfg2_path.read_text(encoding="utf-8"))
    if cfg2["train"]["batch_size"] != 1 or cfg1["train"]["batch_size"] != 1:
        raise ValueError("This check intentionally targets the configured batch_size=1 training")
    report = dict(stage=args.stage or "data-only", success=False, torch=torch.__version__,
                  configs_sha256={str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in (cfg1_path, cfg2_path)},
                  optimizer_steps=0, weights_saved=False)
    output = PROJECT / "checks" / f"real-data-{args.stage or 'inventory'}.json"
    try:
        s1, s2, indices, boundaries = datasets(cfg1, cfg2)
        if args.data_only:
            report["checks"] = audit(cfg1, cfg2, s1, s2, indices, boundaries)
        else:
            report["checks"] = smoke(args.stage, cfg1, cfg2, s1, s2, indices)
        report["success"] = True
    except Exception as exc:
        report["error"] = str(exc)
        report["traceback"] = traceback.format_exc()
        raise
    finally:
        write_json(output, report)
        print(f"Report: {output}", flush=True)


if __name__ == "__main__":
    main()
