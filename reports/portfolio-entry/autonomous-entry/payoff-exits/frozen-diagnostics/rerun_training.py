"""Repeat both 500-proposal fits and chronological evaluation in a separate run directory."""
import fcntl
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from train_end_to_end import CONSTRAINED_UPDATES, evaluate, fit, run_path, torch


def main():
    steps = CONSTRAINED_UPDATES
    original = run_path(steps)
    directory = original.with_name(original.name + "-review-rerun")
    directory.mkdir(exist_ok=True)
    with (directory / ".run.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        torch.backends.cudnn.allow_tf32 = False
        torch.backends.cudnn.deterministic = True
        torch.backends.cuda.matmul.allow_tf32 = False
        device = torch.device("cuda")
        for stage in ("development", "final"):
            fit(directory, stage, steps, device)
        evaluate(directory, device)


if __name__ == "__main__":
    main()
