"""Isolated project context for the normal-timeline Nagato experiment."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "training/nagato_normal_v5"
SOURCE = ROOT / "assets/The Melancholy of Haruhi Suzumiya/Nagato_Normal_v2"
EXPERIMENT = "nagato_normal_v5turbo"


def configure_common():
    """Point shared v5 helpers at this project before importing their wrappers."""
    import common

    common.PROJECT = PROJECT
    common.SOURCE = SOURCE
    common.EXPERIMENT = EXPERIMENT
    return common


def activate() -> None:
    configure_common().activate()
