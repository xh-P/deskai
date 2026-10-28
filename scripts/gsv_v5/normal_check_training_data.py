"""Run the shared actual-loader and gradient checks on the normal-Nagato project."""
from __future__ import annotations

from normal_context import PROJECT, activate, configure_common

common = configure_common()
import check_training_data

check_training_data.PROJECT = PROJECT
check_training_data.activate = activate

if __name__ == "__main__":
    check_training_data.main()
