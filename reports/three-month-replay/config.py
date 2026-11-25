"""Time boundaries and existing Centrypto strategy settings for the three-month replay."""
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
RESEARCH=ROOT/"data/research/centrypto"
CACHE=RESEARCH/HERE.name
REPORTS=HERE.parent
for project in ("ridge-357-day","ridge-news-selection"):
    sys.path.insert(0,str(REPORTS/project))

import fit_extended as prior
from decisions import BAR,DAY,HOUR,MINUTE,dump,file_hash,iso,load,ms,save_json
from prepare import SYMBOLS,pq

ARCHIVE=RESEARCH/"free-hyperliquid-history"
SOURCE_LOCK=REPORTS/"free-hyperliquid-history/dataset-manifest.json"
START=ms("2025-03-22T00:00:00Z")
FIT_STOP=ms("2026-08-07T00:00:00Z")
CAL_START=ms("2026-08-08T00:00:00Z")
CAL_STOP=ms("2026-08-21T00:00:00Z")
TEST_START=ms("2026-08-22T00:00:00Z")
MARK_STOP=ms("2026-11-22T21:25:00Z")
TEST_STOP=MARK_STOP-DAY-BAR
TAIL_START=ms("2026-11-18T00:00:00Z")
ROLES={"long":(1,3,12),"short":(-1,8,30)}
HOLD=288
FEE=.00045
BASE_SLIP=.0001
STRESS_SLIP=.0003
NOTIONAL=100.
GATE=15.
SLOTS=10
RISK_SEEDS=(11,23,37,53,71,89,107,131)

def days(begin,end):
    return range(begin//DAY*DAY,(end-1)//DAY*DAY+DAY,DAY)
