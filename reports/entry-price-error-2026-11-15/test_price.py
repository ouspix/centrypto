import unittest
import numpy as np
from scipy.special import expit
from price_common import setup_target
from price_network import stopping_loss,PriceNetwork
from threadpoolctl import threadpool_limits

class PriceTests(unittest.TestCase):
    def test_absolute_distance_and_scale_invariance(self):
        a=setup_target([100,101,110],[.3,.28,.18],[1,2,3])
        b=setup_target([.01,.0101,.011],[.3,.28,.18],[1,2,3])
        np.testing.assert_allclose(a[3],[0,.01,.1],atol=1e-12)
        np.testing.assert_allclose(a[3],b[3],atol=1e-12)
        self.assertEqual(a[0],0)
    def test_best_return_not_unconditional_lowest_price(self):
        a=setup_target([100,90,110],[.50,.20,.30],[1,2,3])
        self.assertEqual(a[0],0)
    def test_short_uses_precomputed_directional_gain(self):
        a=setup_target([100,110,105],[.20,.30,.25],[1,2,3])
        self.assertEqual(a[0],1)
        self.assertAlmostEqual(a[3][0],10/110)
    def test_tie_breaks_earliest(self):
        self.assertEqual(setup_target([100,100],[.2,.2],[4,2])[0],1)
    def test_perfect_entry_zero_error_and_failed_skip(self):
        h=np.array([[0,1,0],[0,0,0]],float)
        loss,_,v=stopping_loss(h,np.ones_like(h,bool),[[.1,0,.1],[.1,.1,.1]],[.2,0])
        self.assertEqual(loss,0)
    def test_first_entry_prevents_later_loss(self):
        loss,_,_=stopping_loss([[1,1,1]],[[1,1,1]],[[.02,.9,.9]],[.2])
        self.assertAlmostEqual(loss,.02)
    def test_padding_has_no_effect(self):
        a=stopping_loss([[.3,.5]],[[1,1]],[[.1,.02]],[.2])[0]
        b,g,_=stopping_loss([[.3,.5,.99]],[[1,1,0]],[[.1,.02,999]],[.2])
        self.assertAlmostEqual(a,b);self.assertEqual(g[0,-1],0)
    def test_gradient_matches_numerical_derivative(self):
        z=np.array([[-.8,.2,1.3],[.6,-.3,.4]])
        mask=np.array([[1,1,1],[1,1,0]],bool);cost=np.array([[.08,0,.03],[.1,.1,0]]);skip=[.3,0]
        _,g,_=stopping_loss(expit(z),mask,cost,skip)
        for i in range(2):
            for j in range(3):
                hi=z.copy();lo=z.copy();hi[i,j]+=1e-5;lo[i,j]-=1e-5
                numerical=(stopping_loss(expit(hi),mask,cost,skip)[0]-stopping_loss(expit(lo),mask,cost,skip)[0])/2e-5
                self.assertAlmostEqual(numerical,g[i,j],places=8)
    def test_network_learns_entry_timing_and_abstention(self):
        cfg={'hidden':[8,4],'updates':1500,'checkpoints':[0,1500],'episode_batch':16,'learning_rate':.01,'l2':0.}
        x=np.array([[1,-1],[1,0],[1,1],[-1,-1],[-1,0],[-1,1]],'f4')
        p={'index':np.array([[0,1,2],[3,4,5]]),'mask':np.ones((2,3),bool),
           'cost':np.array([[.1,0,.1],[.1,.1,.1]]),'skip':np.array([.3,0]),'success':np.array([1,0],bool),'groups':np.array(['a','b'])}
        net=PriceNetwork(2,cfg,12)
        before=stopping_loss(net.predict(x)[p['index']],p['mask'],p['cost'],p['skip'])[0]
        with threadpool_limits(limits=1):net.train_episodes(x,p,lambda *args:None)
        h=net.predict(x)[p['index']]
        after=stopping_loss(h,p['mask'],p['cost'],p['skip'])[0]
        self.assertLess(after,before*.05);self.assertLess(h[0,0],.05);self.assertGreater(h[0,1],.95)
        self.assertLess(h[1].max(),.05)
        np.testing.assert_allclose(net.predict(x[:2]),net.predict(x)[:2],rtol=1e-6)

if __name__=='__main__':unittest.main()
