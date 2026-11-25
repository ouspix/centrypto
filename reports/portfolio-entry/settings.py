"""Chronological split and predeclared portfolio experiment."""
from pathlib import Path
import sys
OUT = Path(__file__).resolve().parent
sys.path.insert(0, str(OUT.with_name("three-month-replay")))
from config import (START, TEST_START, TEST_STOP, MARK_STOP, MINUTE, DAY, HOUR, BAR, GATE, HOLD,
                    FEE, SYMBOLS, ROLES, SLOTS, NOTIONAL, BASE_SLIP, STRESS_SLIP, RESEARCH,
                    CACHE as ORIGINAL, HERE as ORIGINAL_REPORT, ms, iso, load, save_json, file_hash)
WORK = RESEARCH / OUT.name
sys.path.insert(0,str(WORK/"vendor"))
ENTRY_START = ms("2025-10-01T00:00:00Z")
MONTHS = [ms(f"2026-{m:02d}-01T00:00:00Z") for m in range(2,9)]
# Leave a full 24-hour exit, plus latency and executable-open tolerance, before each boundary.
PURGE = DAY + 10*MINUTE
CAPITAL = 1000.
PENALTY = .005
SIZES = (50.,100.)
RISK = (0.,.10,.30)
TIME_COST = (0.,2.)
MODES = {"base": (0,BASE_SLIP), "stress": (1,STRESS_SLIP)}
def slug(symbol):
    from urllib.parse import quote
    return quote(symbol,safe="")
