"""Every feature belongs to exactly one mandatory/optional block."""
from four_common import *
from data_four import FourData
GROUPS=['price_shape','volume_detail','sma_detail','market_context','derivatives','liquidity','spot','clock','position_history']
CORE_MARKET=['perp_return_pct_5m','perp_return_pct_60m','rolling24h_close_return_pct','perp_rv_pct_60m','perp_log_quote_volume_60m']+[f'sma_gap_{a}_{b}' for a,b in CFG['pairs']]
CORE_ENTRY=CORE_MARKET+['setup_age_fraction','detected_fast_bars','detected_slow_bars']
CORE_EXIT=CORE_MARKET+['trade_return_pct','trade_elapsed_fraction']
def group_for(name,kind):
    if name in (CORE_ENTRY if kind=='entry' else CORE_EXIT):return 'mandatory'
    if name.startswith('news_'):raise AssertionError('News must remain excluded')
    if name.startswith('calendar_'):return 'clock'
    if name.startswith('liquidity_'):return 'liquidity'
    if name.startswith(('derivative_','crossvenue_')):return 'derivatives'
    if name.startswith(('btc_','eth_','relative_btc_')):return 'market_context'
    if name.startswith('spot_'):return 'spot'
    if name.startswith(('sma_','detected_pair_')):return 'sma_detail'
    if name.startswith(('perp_log_quote_volume_','perp_volume_ratio_')):return 'volume_detail'
    if name.startswith('perp_'):return 'price_shape'
    if name.startswith('trade_'):return 'position_history'
    raise AssertionError((kind,name))
def variants():
    out={'core':[],'full':GROUPS.copy()}
    for group in GROUPS:out['add_'+group]=[group];out['drop_'+group]=[g for g in GROUPS if g!=group]
    return out
def main():
    data=FourData();schema={'entry':{},'exit':{}}
    for kind,names in [('entry',data.entry_names),('exit',data.exit_names)]:
        for name in names:schema[kind].setdefault(group_for(name,kind),[]).append(name)
        assert sum(len(v) for v in schema[kind].values())==len(names)
    save('feature-schema.json',schema)
    experiment={'seeds':[20261114,20261115,20261116],'variants':variants(),'outer_folds':4,'workers':4,
       'mandatory_is_design_choice':'Mandatory means retained as the architectural core, not proven necessary by this experiment; the core is not ablated.',
       'masking':'Fit column-wise preprocessing on earlier training data once. Inactive feature values and their missingness indicators are zeroed after scaling. Fixed full input width preserves initial weights and minibatch RNG across paired variants.',
       'selection':'Same earlier validation AP checkpoint and per-side trading threshold selection as baseline. No optional group is selected using test results for deployment.',
       'classification':'Measure add-to-core and remove-from-full effects separately across three paired seeds and four chronological folds. Strong help/harm requires same direction in both contexts for all three seed totals. Otherwise mixed/inconclusive. Features without training variation are not declared noise.',
       'limits':'Previously researched outer periods, not pristine research holdouts. Seeds and folds share observations and are not independent significance samples. Group ablations do not establish that every member is individually useful.'}
    save('experiment.json',experiment)
    print(json.dumps({'counts':{kind:{group:len(v) for group,v in mapping.items()} for kind,mapping in schema.items()},'variants':len(experiment['variants']),'seeds':len(experiment['seeds']),'fold_fits':len(experiment['variants'])*3*4}),flush=True)
if __name__=='__main__':main()
