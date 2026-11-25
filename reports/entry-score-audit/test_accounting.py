import unittest
import numpy as np
from accounting import reprice,marked
from decisions import HOUR,MINUTE
from diagnostics import buckets


class TestAccounting(unittest.TestCase):
    def setUp(self):
        self.opens=np.full(241,100.)
        self.row=dict(symbol="TEST",key="test-TEST",side="long",entry=MINUTE,end=3*HOUR,step=36)

    def test_unknown_exit_keeps_known_flows_and_censors_from_first_missing_cash(self):
        self.opens[180]=np.nan
        market=(0,self.opens,{HOUR:(110.,.001),3*HOUR:(90.,-.002)})
        r=reprice(self.row,market,{},"observed")
        self.assertEqual(r["status"],"unknown_exit")
        self.assertIsNone(r["net"])
        self.assertEqual(r["missing_funding_hours"],[2*HOUR])
        self.assertEqual([f[0] for f in r["funding_flows"]],[HOUR,3*HOUR])
        metrics,grid,equity=marked([r],{"test-TEST":market},0,4*HOUR,1)
        self.assertAlmostEqual(equity[60]-equity[59],-r["qty"]*.110)
        self.assertTrue(np.isfinite(equity[119]))
        self.assertTrue(np.isnan(equity[120:]).all())
        self.assertEqual(len(metrics["end_inventory"]),1)

    def test_oracle_with_rate_and_no_settlement_candle(self):
        row=dict(self.row,side="short",end=HOUR)
        r=reprice(row,(0,self.opens,{}),{},"observed",{("TEST",HOUR):101.},{("TEST",HOUR):.001})
        self.assertEqual(r["status"],"priced")
        self.assertEqual(r["funding_flows"],[(HOUR,r["qty"]*101*.001,"oracle")])
        self.assertEqual(reprice(row,(0,self.opens,{}),{},"observed",{("TEST",HOUR):101.})["status"],"unknown_funding")

    def test_no_entry_has_no_funding(self):
        self.opens[1]=np.nan
        r=reprice(self.row,(0,self.opens,{HOUR:(100.,.001)}),{},"observed")
        self.assertEqual((r["status"],r["funding_flows"]),("unknown_entry",[]))

    def test_tied_forecasts_stay_together(self):
        y=np.arange(100)
        self.assertEqual(len(buckets(np.ones(100),y)),1)
        b=buckets(np.repeat([1.,2.,3.],[50,25,25]),y)
        self.assertEqual(sum(x["priced"] for x in b),100)
        self.assertTrue(all(a["high"]<c["low"] for a,c in zip(b,b[1:])))


if __name__=="__main__":
    unittest.main()
