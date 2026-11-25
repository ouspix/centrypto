"""Rebuild decisions on two calibration days and a later selection day from the captured native tape."""
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
FROZEN = HERE.parent/"capped-entry-value"
sys.path.insert(0,str(FROZEN))
import decisions
from decisions import ForwardData, ms
import forward
import evidence

CACHE = decisions.BASE_CACHE.parent/HERE.name
WINDOW = dict(test_start="2026-11-11T00:00:00Z",test_entry_end="2026-11-16T00:00:00Z",
              test_market_end="2026-11-17T00:00:00Z")


def main():
    CACHE.mkdir(exist_ok=True)
    # ForwardData uses the full frozen source tapes for warm-up. Restrict the detector
    # before building the rows. Only past features and completed pre-benchmark labels are consumed.
    forward.PLAN = dict(forward.PLAN, **WINDOW)
    forward.fresh.ENTRY_END = ms(WINDOW["test_entry_end"])
    decisions.CACHE = CACHE
    decisions.build("development",ForwardData(),WINDOW)
    evidence.CACHE = CACHE
    evidence.capture("development")


if __name__=="__main__":
    main()
