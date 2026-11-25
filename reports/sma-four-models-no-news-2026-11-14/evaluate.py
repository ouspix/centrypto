from four_common import *
from engine import totals
from data_four import FourData
def normalize(row):
    r=dict(row);r['scored']=r['scored'] in [True,'True'];r['holding_minutes']=float(r['holding_minutes']);r['return_pct']=float(r['return_pct']) if r['scored'] else None
    return r
def exposure(rows):
    events=[]
    for r in rows:events.extend([(ms(r['entry_time']),1),(ms(r['exit_time']),-1)])
    active=peak=0
    for at,delta in sorted(events):active+=delta;peak=max(peak,active)
    cumulative=high=drawdown=0.
    for r in sorted(rows,key=lambda r:r['exit_time']):
        if not r['scored']:continue
        cumulative+=r['return_pct'];high=max(high,cumulative);drawdown=max(drawdown,high-cumulative)
    return {'maximum_simultaneous_positions':peak,'peak_gross_notional_usd':100*peak,'realized_exit_order_drawdown_usd':drawdown}
def main():
    d=FourData();new=[normalize(r) for r in csv.DictReader((HERE/'predictions.csv').open())]
    old=[normalize(r) for r in csv.DictReader((SOURCE/'predictions.csv').open()) if r['policy']=='two_stage']
    plans=json.loads((HERE/'fold-plan.json').read_text());out={'all_folds':{},'folds':[],'fees':0,'comparison_kind':'Whole-system comparison; detector, labels, capacity, side separation, exit training and validation selection change together.'}
    for name,rows in [('current',old),('sma_four',new)]:
        out['all_folds'][name]={**totals(rows),**exposure(rows),'by_side':{side:totals([r for r in rows if r['side']==side]) for side in ['long','short']}}
    for p in plans:
        fold=p['start'];out['folds'].append({'start':fold,'end':p['end'],**{name:{**totals([r for r in rows if r['fold']==fold]),'by_side':{side:totals([r for r in rows if r['fold']==fold and r['side']==side]) for side in ['long','short']}} for name,rows in [('current',old),('sma_four',new)]}})
    active_old={r['fold'] for r in old}
    out['same_folds_where_current_traded']={name:{**totals([r for r in rows if r['fold'] in active_old]),'by_side':{side:totals([r for r in rows if r['fold'] in active_old and r['side']==side]) for side in ['long','short']}} for name,rows in [('current',old),('sma_four',new)]}
    # Score rally participation separately; all trades, including failed setups,
    # remain in primary PnL. Matching windows can overlap, so never sum event PnL.
    teachers=json.loads((SOURCE_CACHE/'teachers.json').read_text());events=[]
    for p in plans:
        start,end=ms(p['start']),ms(p['end']);cids=d.replay_ids(start,end)
        for e in teachers:
            at=ms(e['teacher_entry_time']);c=d.d.catalog[e['series']]
            if not(start<=at<min(end,ms(c['end']))-1472*MIN):continue
            if ms(e['label_available'])>min(end,ms(c['end'])):continue
            lower=max(start,ms(e['anchor_time'])-1440*MIN);upper=ms(e['anchor_time'])
            match=cids[(d.c['side'][cids]==e['side_sign'])&(d.d.state['series'][d.c['row'][cids]]==e['series'])]
            times=d.d.state['time'][d.c['row'][match]]+55000;detected=bool(((times>=lower)&(times<=upper)).any())
            row={'event_id':e['id'],'fold':p['start'],'symbol':e['symbol'],'side':e['side'],'teacher_gain_pct':e['teacher_gain_pct'],'detected':detected}
            for name,rows in [('current',old),('sma_four',new)]:
                trades=[r for r in rows if r['fold']==p['start'] and r['symbol']==e['symbol'] and r['side']==e['side'] and lower<=ms(r['entry_time'])<=upper]
                row[name+'_participated']=bool(trades);row[name+'_positive_trade_in_window']=any(r['scored'] and r['return_pct']>0 for r in trades)
            events.append(row)
    out['rally_participation']={side:{'events':len([e for e in events if e['side']==side]),'detected':sum(e['side']==side and e['detected'] for e in events),
        **{name+'_participated':sum(e['side']==side and e[name+'_participated'] for e in events) for name in ['current','sma_four']}} for side in ['long','short']}
    out['rally_method']='Fixed previously accepted >=+10% / <=-10% 24h rally windows; teacher entry inside comparable replay period, labels available by its end. Detection/participation means a same-direction eligible entry opportunity/trade in the preceding-24h anchor window. Overlapping event windows are not independent and carry no additive PnL.'
    save('rally-events.json',events);save('comparison.json',out)
    print(json.dumps({'all_folds':out['all_folds'],'common_active_folds':out['same_folds_where_current_traded'],'rallies':out['rally_participation']}),flush=True)
if __name__=='__main__':main()
