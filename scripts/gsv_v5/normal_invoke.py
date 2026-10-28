"""Invoke one pinned upstream entry point with normal-Nagato environment paths."""
from normal_context import activate

activate()

from invoke import main

if __name__ == "__main__":
    main()
