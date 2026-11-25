"""Validated research inference boundary. Caller supplies contemporaneous features."""
from policy_four import Policy
class ResearchPolicy(Policy):
    def decide_entry(self,closed_prices,closed_times,features,*,eligible,used_events=(),already_open=False):
        """closed_times identify each completed bar; eligible applies frozen liquidity/data rules.

        Feature values must be observed by this decision. News is excluded.
        Missing observations use NaN. No orders are placed here.
        Used event keys are (side,pair_id,detected_time), stable across rolling buffers.
        """
        if len(closed_prices)!=len(closed_times):raise ValueError('Close/time length mismatch')
        if len(closed_times)<max(max(p) for p in self.config['pairs'])+self.config['entry_window_minutes']//5+1:
            return {'action':'wait','reason':'insufficient_detector_history'}
        if any(b-a!=300000 for a,b in zip(closed_times,closed_times[1:])):raise ValueError('Expected a regular 5m grid; retain missing closes as NaN')
        if not eligible:return {'action':'wait','reason':'ineligible_market_state'}
        index={time:i for i,time in enumerate(closed_times)}
        used=[(side,pair,index[time]) for side,pair,time in used_events if time in index]
        result=self.entry(closed_prices,features,used,already_open)
        if result['action']=='enter':
            setup=result['setup'];setup['detected_time']=closed_times[setup['detected_bar']]
            result['event_key']=(setup['side'],setup['pair_id'],setup['detected_time'])
        return result
