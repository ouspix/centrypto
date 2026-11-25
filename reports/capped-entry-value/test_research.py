import unittest

import numpy as np

from archive_inputs import depth_fill
from decisions import DAY,HOUR,MINUTE,trade_costs
from forecast import block,calibration
from portfolio import allocate,portfolio,quote,reprice


def candidate(cid,symbol,at=0,end=10*MINUTE,side="long"):
    return dict(id=cid,symbol=symbol,side=side,setup=cid,decision=at,entry=at+MINUTE,
                end=end,status="priced",step=1,key="recent-"+symbol,setup_start=at,setup_end=at)


class AllocationTests(unittest.TestCase):
    def test_wait_retries_and_ties_are_independent_of_input_order(self):
        a,b = candidate(1,"A"),candidate(2,"B")
        later = dict(b,id=3,decision=15*MINUTE,entry=16*MINUTE,end=20*MINUTE)
        rows,counts = allocate([(b,11,5),(later,12,5),(a,11,5)],1,DAY)
        self.assertEqual([r["symbol"] for r in rows],["A","B"])
        self.assertEqual(counts["capacity_rejections"],1)

    def test_economic_hurdle_strict_and_no_reentry(self):
        a = candidate(1,"A")
        second = dict(a,id=2,decision=20*MINUTE)
        rows,counts = allocate([(a,10,5),(second,20,5),(candidate(3,"B"),5,5)],2,DAY)
        self.assertEqual(len(rows),1)
        self.assertEqual(counts["episode_entered"],1)

    def test_chronological_purge(self):
        a = candidate(1,"A",at=5,end=12)
        mask = block([a,dict(a,end=9,setup_end=10),dict(a,end=9,setup_end=9),
                      dict(a,end=9,setup_start=3),dict(a,end=8,status="unknown_funding")],5,10)
        self.assertEqual(mask.tolist(),[False,False,True,False,False])
        self.assertEqual(calibration(np.ones(3),np.array([1.,2.,3.])),(0.,2.))


class ExecutionTests(unittest.TestCase):
    def test_candle_identity_and_oracle_units(self):
        for side,sign in (("long",1),("short",-1)):
            r = candidate(1,"A",end=HOUR,side=side)
            opens = np.linspace(100,101,61)
            m = (0,opens,{HOUR:(101.,.001)})
            actual = reprice(r,m,{},"candle")
            expected = trade_costs(opens[1],101.,sign,101*.001)
            for k in expected:
                self.assertAlmostEqual(actual[k],expected[k])
            oracle = reprice(r,m,{},"observed",{("A",HOUR):90.})
            self.assertAlmostEqual(oracle["funding"],sign*oracle["qty"]*90*.001)
            self.assertEqual(oracle["funding_flows"][0][2],"oracle")

    def test_quotes_must_be_received_and_size_sufficient(self):
        t = dict(tick_at=1000,received=1001,book_at=1000,book_received=1002,bid=99,ask=101,bid_size=2,ask_size=2)
        self.assertIsNone(quote(t,1001))
        self.assertIsNone(quote(t,3100))
        self.assertEqual(quote(t,1100),(99,101,2,2))
        book = {"depth":(1000,1001,[[dict(px="99",sz="2")],[dict(px="100",sz=".5"),dict(px="101",sz="1")]])}
        p,src = depth_fill(book,1100,1,None,100)
        self.assertEqual(src,"observed_l2")
        self.assertAlmostEqual(p,100/(.5+50/101))
        self.assertEqual(depth_fill(book,1100,-1,3,100),(None,"insufficient_size"))

    def test_marked_drawdown_and_missing_funding(self):
        r = candidate(1,"A",end=3*MINUTE)
        market = (0,np.array([100.,100.,90.,100.,100.]),{})
        trade = reprice(r,market,{},"candle")
        metrics,_,equity = portfolio([trade],{r["key"]:market},0,4*MINUTE,1)
        self.assertGreater(metrics["full_drawdown"],9.9)
        self.assertAlmostEqual(equity[-1],trade["net"])
        missing = reprice(dict(r,end=HOUR),(0,np.ones(61),{}),{},"candle")
        self.assertEqual(missing["status"],"unknown_funding")
        self.assertIsNone(missing["net"])

    def test_funding_at_entry_excluded_and_rejected_entry_can_retry(self):
        r = dict(candidate(1,"A",end=HOUR+MINUTE),entry=HOUR)
        trade = reprice(r,(0,np.ones(62),{}),{},"candle")
        self.assertEqual(trade["funding_flows"],[])
        rejected = dict(r,status="entry_rejected")
        later = dict(r,id=2,decision=HOUR+MINUTE,entry=HOUR+2*MINUTE,end=HOUR+3*MINUTE)
        trades,counts = allocate([(rejected,4,0),(later,5,0)],1,DAY)
        self.assertEqual([t["id"] for t in trades],[2])
        self.assertEqual(counts["arrival_rejections"],1)


if __name__=="__main__":
    unittest.main()
