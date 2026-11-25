import unittest
from repair_common import *
from repair_data import RepairData, ENTRY_CORE, EXIT_CORE
from repair_network import QualityPreprocess
from repair_replay import block_bound

class RepairTests(unittest.TestCase):
    def test_suffix_decisions_both_directions(self):
        np.testing.assert_array_equal(suffix_exit_labels([100,115,102,112],1),[0,1,0,1])
        np.testing.assert_array_equal(suffix_exit_labels([100,85,98,88],-1),[0,1,0,1])
        np.testing.assert_array_equal(suffix_exit_labels([100,99,98],1),[1,1,1])
    def test_entry_barriers_and_partial_future(self):
        self.assertEqual(first_barrier_label(np.array([3,8])),0)
        self.assertEqual(first_barrier_label(np.array([-11,15])),0)
        self.assertEqual(first_barrier_label(np.array([-9,10,-20])),1)
        np.testing.assert_array_equal(coverage_mask([100,110,np.nan,120],2),[False,False,False,False])
    def test_preprocess_is_training_only_and_never_imputes_core(self):
        x=np.column_stack([np.arange(40.),np.full(40,np.nan),np.arange(40.)]);x[:4,2]=np.nan
        pre=QualityPreprocess().fit(x,['core','absent','optional'],['core'])
        self.assertIn('absent',pre.dropped);self.assertNotIn('absent',pre.names)
        before=pre.median.copy();z=np.array([[np.nan,1000,np.nan]])
        self.assertFalse(pre.valid(z)[0]);pre.transform(z);np.testing.assert_equal(before,pre.median)
        with self.assertRaises(AssertionError):QualityPreprocess().fit(z,['core','absent','optional'],['core'])
    def test_selector_rejects_tiny_concentrated_profit(self):
        trades=[{'scored':True,'return_pct':.35/375,'entry_time':'2026-06-01T00:00:00Z','symbol':'BTC'} for _ in range(375)]
        self.assertFalse(block_bound(trades,['2026-06-01','2026-06-02','2026-06-03'])['pass'])
    def test_actual_boundary_and_causal_population(self):
        from causal_candidates import CausalData
        d=CausalData();p=PLANS[0];ids=d.replay_ids(ms(p['start']),ms(p['end']),quality=False)
        ends=d.actual_ends[d.d.state['series'][d.c['row'][ids]]]
        self.assertTrue(np.all(d.d.state['time'][d.c['row'][ids]]+55000+H*BAR<ends))
        self.assertGreater(d.restored['restored_unpriced_candidates'],0)
        restored=np.arange(d.original_candidate_count,len(d.c))
        self.assertTrue(np.isnan(d.d.state['price'][d.c['row'][restored]]).all())
        self.assertTrue(np.isnan(d.labels[restored]).all())
        original=d.labels;d.labels=np.full(len(d.c),np.nan)
        np.testing.assert_array_equal(ids,d.replay_ids(ms(p['start']),ms(p['end']),quality=False));d.labels=original
        # No row-level future availability or label test participates in candidate admission.
        gated=d.replay_ids(ms(p['start']),ms(p['end']))
        raw=d.entry_rows(gated);self.assertTrue(np.isfinite(raw[:,[d.entry_names.index(n) for n in ENTRY_CORE]]).all())
    def test_runtime_availability_guard_and_deadline(self):
        from repair_policy import Policy, observed_features
        p=Policy(HERE/'models')
        self.assertEqual(p.entry([1]*100,{},0)['reason'],'historical_availability_unverified')
        self.assertEqual(p.exit('long',{},1440,0)['reason'],'holding_deadline')
        self.assertEqual(p.exit('short',{},5,0)['reason'],'missing_mandatory_state')
        self.assertEqual(p.exit('short',{},10,0,exit_requested=True)['reason'],'pending_exit_request')
        self.assertIsNone(observed_features({'x':1},100,{'x':101}))
        self.assertTrue(np.isnan(observed_features({'derivative_funding_bps':1},120001,{'derivative_funding_bps':0})['derivative_funding_bps']))
    def test_configuration_corruption_is_detected_before_loading_weights(self):
        import tempfile
        from repair_policy import Policy
        with tempfile.TemporaryDirectory(dir=CACHE) as folder:
            p=pathlib.Path(folder);(p/'policy-config.json').write_text('{}');(p/'checksums.json').write_text(json.dumps({'policy-config.json':'0'*64}))
            with self.assertRaisesRegex(ValueError,'configuration checksum'):Policy(p)

if __name__=='__main__':unittest.main()
