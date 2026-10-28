"""Run one upstream entry point inside the project-local Conda environment."""
import os
import runpy
import sys
from pathlib import Path, PosixPath, WindowsPath

from common import REPO, activate

def main():
    activate()
    target = (REPO / sys.argv[1]).resolve()
    if not target.is_relative_to(REPO.resolve()):
        raise SystemExit("Entry point must be inside the pinned upstream checkout.")
    os.chdir(REPO)
    import torch

    # Lightning's own local checkpoints contain the output directory as a Path.
    torch.serialization.add_safe_globals([Path, PosixPath, WindowsPath])
    sys.argv = [str(target), *sys.argv[2:]]
    runpy.run_path(str(target), run_name="__main__")


if __name__ == "__main__":
    main()
