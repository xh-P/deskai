"""Check local dependencies and synthetic gradients without updating/saving weights."""
from __future__ import annotations

import argparse
import gc
import json
import os
import shutil
import time

from common import PRETRAINED, PROJECT, REPO, SOURCE, VERSION, activate, write_json


def frontend():
    import numpy as np
    from tools.my_utils import load_audio
    from text.cleaner import clean_text
    from transformers import AutoModelForMaskedLM, AutoTokenizer, HubertModel
    from tools.portable_runtime import FFMPEG_EXE
    assert FFMPEG_EXE.is_file(), str(FFMPEG_EXE)
    wav = next(SOURCE.glob("*.wav"))
    audio = load_audio(str(wav), 16000)
    assert len(audio) and np.isfinite(audio).all()
    phones, _, text = clean_text("ありがとう。", "ja", VERSION)
    assert len(phones) > 3 and "UNK" not in phones
    tokenizer = AutoTokenizer.from_pretrained(PRETRAINED / "chinese-roberta-wwm-ext-large", local_files_only=True)
    bert = AutoModelForMaskedLM.from_pretrained(PRETRAINED / "chinese-roberta-wwm-ext-large", local_files_only=True)
    del bert
    gc.collect()
    hubert = HubertModel.from_pretrained(PRETRAINED / "chinese-hubert-base", local_files_only=True)
    return dict(japanese_text=text, phoneme_count=len(phones), audio_decode_samples=len(audio),
                ffmpeg=shutil.which("ffmpeg"), bert_tokenizer=type(tokenizer).__name__, hubert=type(hubert).__name__)


def sovits():
    import torch
    from peft import LoraConfig, get_peft_model
    from module.models import SynthesizerTrnV3
    cfg = json.loads((PROJECT / "configs/sovits.json").read_text(encoding="utf-8"))
    model = SynthesizerTrnV3(cfg["data"]["filter_length"] // 2 + 1,
                            cfg["train"]["segment_size"] // cfg["data"]["hop_length"],
                            n_speakers=cfg["data"]["n_speakers"], **cfg["model"])
    checkpoint = torch.load(cfg["train"]["pretrained_s2G"], map_location="cpu", weights_only=False)
    loaded = model.load_state_dict(checkpoint["weight"], strict=False)
    assert not loaded.missing_keys and not loaded.unexpected_keys, str(loaded)
    del checkpoint
    gc.collect()
    model.cfm = get_peft_model(model.cfm, LoraConfig(target_modules=["to_k", "to_q", "to_v", "to_out.0"],
                              r=16, lora_alpha=16, init_lora_weights=True))
    model.cuda().train()
    results = []
    for seconds in (2, 12):
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        frames = seconds * 50
        length = torch.tensor([frames], device="cuda")
        phone_len = seconds * 8
        with torch.autocast("cuda", dtype=torch.float16):
            loss = model(torch.randn(1, 768, frames, device="cuda"),
                         torch.randn(1, 1025, frames, device="cuda"),
                         torch.randn(1, 100, frames * 2, device="cuda"),
                         length.cpu(), length,
                         torch.randint(0, 100, (1, phone_len), device="cuda"),
                         torch.tensor([phone_len], device="cuda"), length * 2, use_grad_ckpt=True)
        assert torch.isfinite(loss), "Non-finite v5 loss"
        loss.backward()
        gradients = [p.grad for n, p in model.named_parameters() if "lora_" in n and p.grad is not None]
        assert gradients and all(torch.isfinite(g).all() for g in gradients), "Invalid LoRA gradients"
        assert any(torch.count_nonzero(g) for g in gradients), "Zero LoRA gradients"
        torch.cuda.synchronize()
        results.append(dict(seconds=seconds, synthetic_loss=loss.item(), finite_lora_gradients=len(gradients),
                            elapsed_seconds=round(time.perf_counter() - started, 2),
                            peak_allocated_mib=round(torch.cuda.max_memory_allocated() / 2**20),
                            peak_reserved_mib=round(torch.cuda.max_memory_reserved() / 2**20)))
        print(json.dumps(results[-1]), flush=True)
        model.zero_grad(set_to_none=True)
        del loss, gradients
        torch.cuda.empty_cache()
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    return dict(version=model.version, trainable_parameters=trainable, samples=results,
                optimizer_steps=0, weights_saved=False)


def gpt():
    import torch
    import yaml
    from AR.models.t2s_lightning_module import Text2SemanticLightningModule
    cfg = yaml.safe_load((PROJECT / "configs/gpt.yaml").read_text(encoding="utf-8"))
    model = Text2SemanticLightningModule(cfg, PROJECT / "checks", is_train=False)
    checkpoint = torch.load(cfg["pretrained_s1"], map_location="cpu", weights_only=False)
    model.load_state_dict(checkpoint["weight"], strict=True)
    del checkpoint
    model.cuda().train()
    torch.cuda.reset_peak_memory_stats()
    with torch.autocast("cuda", dtype=torch.float16):
        loss, acc = model.model.forward_old(torch.randint(0, 100, (1, 96), device="cuda"),
                    torch.tensor([96], device="cuda"), torch.randint(0, 1024, (1, 300), device="cuda"),
                    torch.tensor([300], device="cuda"), torch.zeros(1, 1024, 96, device="cuda"))
    assert torch.isfinite(loss), "Non-finite GPT loss"
    loss.backward()
    gradients = [p.grad for p in model.parameters() if p.grad is not None]
    assert gradients and all(torch.isfinite(g).all() for g in gradients), "Invalid GPT gradients"
    torch.cuda.synchronize()
    return dict(base="s1v3.ckpt", synthetic_seconds=12, synthetic_loss=loss.item(),
                finite_gradient_tensors=len(gradients),
                peak_allocated_mib=round(torch.cuda.max_memory_allocated() / 2**20),
                peak_reserved_mib=round(torch.cuda.max_memory_reserved() / 2**20),
                optimizer_steps=0, weights_saved=False)


if __name__ == "__main__":
    activate()
    os.chdir(REPO)
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["frontend", "sovits", "gpt"])
    args = parser.parse_args()
    import torch
    torch.manual_seed(1234)
    torch.set_num_threads(4)
    assert torch.cuda.is_available(), "CUDA unavailable"
    report = dict(stage=args.stage, torch=torch.__version__, cuda=torch.version.cuda,
                  gpu=torch.cuda.get_device_name(), checks=globals()[args.stage]())
    write_json(PROJECT / "checks" / (args.stage + ".json"), report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
