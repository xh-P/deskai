"""Verify the resumed 8/15-epoch run and record its artifacts and provenance."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from common import PROJECT, activate, write_json


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    activate()
    import torch
    import yaml
    from process_ckpt import load_sovits_new
    from tensorboard.backend.event_processing import event_accumulator

    backup = PROJECT / "backups/pre_extension_20261024-043317"
    old_report = json.loads((backup / "training-completed.before-extension.json").read_text(encoding="utf-8"))
    original_hashes = json.loads((backup / "original_hashes.json").read_text(encoding="utf-8-sig"))
    config_gpt = yaml.safe_load((PROJECT / "configs/gpt.yaml").read_text(encoding="utf-8"))
    config_sovits = json.loads((PROJECT / "configs/sovits.json").read_text(encoding="utf-8"))
    assert (config_sovits["train"]["epochs"], config_sovits["train"]["save_every_epoch"]) == (8, 2)
    assert (config_gpt["train"]["epochs"], config_gpt["train"]["save_every_n_epoch"]) == (15, 5)
    assert json.loads((PROJECT / "status.json").read_text(encoding="utf-8"))["status"] == "completed"

    # Ensure every export from the first run is byte-for-byte intact.
    old_weights = []
    for row in old_report["weights"]:
        path = Path(row["path"])
        assert path.stat().st_size == row["bytes"], path
        assert sha256(path) == row["sha256"], path
        old_weights.append(str(path))
    for row in original_hashes:
        source = Path(row["Path"])
        copied = backup / source.name
        assert copied.is_file() and sha256(copied) == row["Hash"].lower(), copied

    s2_dir = PROJECT / "weights/sovits"
    s1_dir = PROJECT / "weights/gpt"
    new_exports = []
    for epoch in (4, 6, 8):
        matches = list(s2_dir.glob(f"*_e{epoch}_s*_l16.pth"))
        assert len(matches) == 1, (epoch, matches)
        path = matches[0]
        payload = load_sovits_new(str(path))
        assert payload["info"] == f"{epoch}epoch_{epoch * 320}iteration", path
        assert payload["lora_rank"] == 16 and payload["weight"], path
        assert path.open("rb").read(2) == b"08", path
        new_exports.append(path)
    gpt_export = s1_dir / "nagato_disappearance_v5turbo-e15.ckpt"
    payload = torch.load(gpt_export, map_location="cpu", weights_only=False)
    assert payload["info"] == "GPT-e15" and payload["weight"], gpt_export
    new_exports.append(gpt_export)
    del payload

    s2_checkpoint = PROJECT / "features/43f0b4a08286/logs_s2_v5turbo_lora_16/G_233333333333.pth"
    s2 = torch.load(s2_checkpoint, map_location="cpu", mmap=True, weights_only=False)
    s2_optimizer_steps = sorted({int(value["step"]) for value in s2["optimizer"]["state"].values()})
    assert s2["iteration"] == 8 and len(s2["optimizer"]["state"]) == 233, s2_checkpoint
    assert s2_optimizer_steps and min(s2_optimizer_steps) > 640, s2_optimizer_steps
    del s2

    gpt_checkpoints = list((PROJECT / "checkpoints/gpt/ckpt").glob("epoch=*.ckpt"))
    assert len(gpt_checkpoints) == 1 and gpt_checkpoints[0].name == "epoch=14-step=1200.ckpt", gpt_checkpoints
    gpt = torch.load(gpt_checkpoints[0], map_location="cpu", mmap=True, weights_only=False)
    gpt_optimizer_steps = sorted({int(value["step"]) for value in gpt["optimizer_states"][0]["state"].values()})
    assert (gpt["epoch"], gpt["global_step"]) == (14, 1200)
    assert gpt_optimizer_steps and min(gpt_optimizer_steps) > 790, gpt_optimizer_steps
    assert gpt["lr_schedulers"] and gpt["MixedPrecision"] and gpt["state_dict"]
    del gpt

    log = (PROJECT / "logs/20261024-043506-all.stdout.log").read_text(encoding="utf-8", errors="replace")
    assert "start training from epoch 3" in log
    assert "ckpt_path:" in log and "epoch=9-step=800.ckpt" in log
    assert "training done" in log

    metric_names = ("total_loss_epoch", "top_3_acc_epoch", "lr_epoch")
    metrics = {name: [] for name in metric_names}
    for version in ("version_1", "version_2"):
        events = event_accumulator.EventAccumulator(str(PROJECT / "checkpoints/gpt/gpt" / version)).Reload()
        for name in metric_names:
            metrics[name].extend(dict(step=item.step, value=item.value) for item in events.Scalars(name))
    assert all(len(values) == 15 for values in metrics.values())

    all_exports = sorted((s2_dir.glob("*.pth")), key=str) + sorted((s1_dir.glob("*.ckpt")), key=str)
    report = dict(
        date=datetime.now(timezone.utc).isoformat(),
        sovits_epochs=8, gpt_epochs=15, training_clips=320, completed=True,
        resume=dict(sovits_from_epoch=2, gpt_from_epoch=10,
                    sovits_optimizer_initial_step=640, sovits_optimizer_final_steps=s2_optimizer_steps,
                    gpt_optimizer_initial_step=790, gpt_optimizer_final_steps=gpt_optimizer_steps,
                    sovits_grad_scaler_restored=False,
                    backup=str(backup), old_export_count=len(old_weights)),
        checkpoints=[str(s2_checkpoint), str(gpt_checkpoints[0])], metrics=metrics,
        weights=[dict(path=str(path), bytes=path.stat().st_size, sha256=sha256(path)) for path in all_exports],
        new_exports=[str(path) for path in new_exports],
        note="All original exports preserved by SHA256. Internal epoch and optimizer state verified; SoVITS GradScaler is not stored by upstream.",
    )
    write_json(PROJECT / "checks/training-completed.json", report)
    print(json.dumps({key: report[key] for key in ("sovits_epochs", "gpt_epochs", "completed", "resume", "new_exports")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
