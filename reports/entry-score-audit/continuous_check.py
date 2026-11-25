"""Measure entry discrimination on the separately frozen 218-day ridge and its own corrected exits."""
import sys
import joblib
import numpy as np
from study import HERE, BASE, SIDES, CALIBRATE, SELECT, source, decomposition, load, file_hash, save_json, ms
from accounting import priced

CONTINUOUS=HERE.parent/"continuous-entry-value"
sys.path.insert(0,str(CONTINUOUS))
from fit_continuous import score
from stable_exits import apply_to


def main():
    bundle=joblib.load(CONTINUOUS/"entry-models.joblib")
    assert file_hash(CONTINUOUS/"entry-models.joblib")==load(CONTINUOUS/"research-lock.json")["bundle_sha256"]
    hist,he=source("history")
    apply_to(hist,"history")
    calibration=priced(hist,he,"observed")
    test,be=source("benchmark")
    apply_to(test,"benchmark")
    rr=priced(test,be,"observed")
    p,constant={},{}
    for s in SIDES:
        values=[r["net_bps"] for r in calibration[s] if r["setup_start"]>=CALIBRATE and
                r["decision"]<SELECT and r["status"]=="priced"]
        p[s]=score(bundle["models"]["continuous"][s],test["sides"][s])
        constant[s]=np.full(len(p[s]),np.mean(values))
    start,end=[ms(test["window"][k]) for k in ("test_start","test_market_end")]
    result=decomposition(test,rr,p,constant,start,end)
    expected=load(CONTINUOUS/"benchmark.json")["modes"]["observed"]["continuous"]
    np.testing.assert_allclose(result["ridge"]["net"],expected["net"],rtol=1e-12)
    save_json(HERE/"continuous-control.json",dict(model=file_hash(CONTINUOUS/"entry-models.joblib"),
                  constant_bps={s:v[0] for s,v in constant.items()},score_contribution=result))
    print({k:v["net"] for k,v in result.items() if "net" in v})


if __name__=="__main__":
    main()
