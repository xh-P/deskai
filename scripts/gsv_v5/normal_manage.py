"""Run the shared v5 workflow with isolated normal-Nagato paths and labels."""
from __future__ import annotations

import os
import subprocess
import sys

from normal_context import EXPERIMENT, PROJECT, ROOT, SOURCE, activate, configure_common

common = configure_common()
import manage

# manage imports constants from common by value, so bind every project-specific
# value explicitly and make its child processes activate this same context.
manage.PROJECT = PROJECT
manage.SOURCE = SOURCE
manage.EXPERIMENT = EXPERIMENT
manage.activate = activate


def run(entry: str, *args: str, env: dict | None = None) -> None:
    command = [str(common.ENV / "python.exe"), "-u", str(ROOT / "scripts/gsv_v5/normal_invoke.py"), entry, *args]
    print("RUN " + subprocess.list2cmdline(command), flush=True)
    subprocess.run(command, cwd=common.REPO, env=env or os.environ.copy(), check=True)


manage.run = run

if __name__ == "__main__":
    manage.main()
