import os
os.environ.setdefault('MPLCONFIGDIR','/mnt/c/Users/melli/.codex/research/centrypto/data-label-audit-2026-11-15/matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from audit_common import *
from network import predict

def main():
    data=FourData();chosen=[];used=set();seed=20261114
    categories=['strong_positive','eight_percent_negative','profitable_below_95pct','adverse_before_success','post_peak_recovery','failed_setup','unresolved_future','reversal','recent_positive']
    pool=[]
    for p in PLANS:
        for cid in data.replay_ids(ms(p['start']),ms(p['end'])):pool.append((int(cid),p))
    # Deliberate diagnostic selection, not a random sample or performance estimate.
    for side,name in [(1,'long'),(-1,'short')]:
        for category in categories:
            for cid,p in pool:
                c=data.c[cid];e=int(c['row']);cat=data.d.catalog[int(data.d.state['series'][e])]
                if c['side']!=side or (cat['symbol'],e) in used:continue
                gain=float(c['gain']);label=float(c['label']);setup=data.setups[int(c['setup'])]
                if category=='strong_positive' and not (label==1 and gain>=25):continue
                if category=='eight_percent_negative' and not (label==0 and 7.5<=gain<=8.5):continue
                if category=='profitable_below_95pct' and not (label==0 and gain>=10 and gain<.95*setup['best_gain']):continue
                if category in ['adverse_before_success','post_peak_recovery','reversal'] and not (np.isfinite(label) and gain>=10):continue
                if category=='failed_setup' and not (np.isfinite(label) and gain<=0):continue
                if category=='unresolved_future' and np.isfinite(label):continue
                if category=='recent_positive' and not (label==1 and p['start'].startswith('2026-11-11')):continue
                prices=np.array(data.d.state['price'][e:e+H+1]);prices[0]=data.d.state['price'][e];ret=side*100*(prices/prices[0]-1)
                if np.isfinite(ret[1:]).sum()<20:continue
                best=int(np.nanargmax(ret[1:])+1);mae=float(np.nanmin(ret[:best+1]));remaining=np.maximum.accumulate(np.where(np.isfinite(ret),ret,-np.inf)[::-1])[::-1]
                recover=(np.arange(H+1)>best)&np.isfinite(ret)&(remaining-ret>=5)
                if category=='adverse_before_success' and not (label==1 and mae<=-5):continue
                if category=='post_peak_recovery' and not np.any(recover):continue
                if category=='reversal' and not (best<144 and np.isfinite(ret[-1]) and ret[-1]<0):continue
                used.add((cat['symbol'],e));chosen.append({'category':category,'side':name,'side_sign':side,'candidate_id':cid,'entry_index':e,'fold':p['start'],'symbol':cat['symbol'],'period':cat['period'],
                    'entry_time':iso(int(data.d.state['time'][e])+55000),'label':int(label) if np.isfinite(label) else None,'gain_pct':gain if np.isfinite(gain) else None,'setup_best_gain_pct':float(setup['best_gain']) if np.isfinite(setup['best_gain']) else None,
                    'best_step':best,'adverse_before_best_pct':mae,'recovery_example_step':int(np.flatnonzero(recover)[0]) if np.any(recover) else None});break
            else:raise AssertionError(('No example',name,category))
    cases=[];allstates=[];modelcache={};out=OUT/'paths';out.mkdir(exist_ok=True)
    for i,item in enumerate(chosen):
        cid=item['candidate_id'];c=data.c[cid];e=item['entry_index'];side=item['side_sign'];name=item['side'];fold=item['fold'];entry=float(data.d.state['price'][e]);steps=np.arange(1,H+1);rr=e+steps
        key=(fold,name)
        if key not in modelcache:modelcache[key]={kind:artifact(fold,seed,name,kind) for kind in ['entry','exit']}
        models=modelcache[key];score=float(predict(models['entry'],data.entry_rows([cid]))[0]);run=json.loads((CACHE/'runs'/f'full__{seed}__{fold[:10]}.json').read_text());policy=run['policies'][name]
        raw=data.exit_rows(np.full(H,e),rr,side);scores=predict(models['exit'],raw);threshold=policy['exit_threshold'] if policy['exit_threshold'] is not None else .5
        path=exit_predictions(data,models['exit'],[e],side,[threshold]);model_step=int(path['steps'][0,0]);best=int(data.d.oracle_exits[e,0 if side==1 else 1])-e
        ret=side*100*(data.d.state['price'][e:e+H+1]/entry-1);labels=(steps>=best).astype(int)
        setup_ids=np.flatnonzero(data.c['setup']==c['setup']);window=data.c[setup_ids];offsets=(window['row']-e)*5
        fig,axes=plt.subplots(3,1,figsize=(11,8),gridspec_kw={'height_ratios':[2.5,1,1]},sharex=True)
        x=np.arange(H+1)*5/60;axes[0].plot(x,ret,color='#264f86',lw=1.5,label='Side-adjusted return at executable prices')
        axes[0].axhline(0,color='#888888',lw=.8);axes[0].axvline(best*5/60,color='#148447',ls='--',label='Best observed exit')
        axes[0].axvline(model_step*5/60,color='#ba3b36',ls=':',label='Exit model, forced entry')
        rec=item['recovery_example_step']
        if rec:
            future=np.nanmax(ret[rec+1:]);axes[0].annotate(f'Label EXIT\n{ret[rec]:+.1f}% now; later {future:+.1f}%',xy=(rec*5/60,ret[rec]),xytext=(.67,.25),textcoords='axes fraction',arrowprops={'arrowstyle':'->'},fontsize=9,bbox={'facecolor':'white','alpha':.85,'edgecolor':'none'})
        for row,t in zip(window,offsets):
            if -60<=t<=60:
                v=side*100*(data.d.state['price'][int(row['row'])]/entry-1);color='#158447' if row['label']==1 else '#ca4540' if row['label']==0 else '#999999'
                axes[0].scatter(t/60,v,c=color,s=22,zorder=4)
        axes[0].set_ylabel('Return from entry (%)');axes[0].legend(fontsize=8,loc='best')
        priceaxis=axes[0].secondary_yaxis('right',functions=(lambda y:entry*(1+side*y/100),lambda px:side*100*(px/entry-1)));priceaxis.set_ylabel('Price')
        axes[1].step(steps*5/60,labels,where='post',label='Existing exit target',color='#664c9a');axes[1].set_ylim(-.1,1.1);axes[1].set_yticks([0,1],['HOLD','EXIT'])
        axes[2].plot(steps*5/60,scores,label='Exit score',color='#bf7821');axes[2].axhline(threshold,color='#777777',ls='--',label=f'Threshold {threshold}');axes[2].set_ylim(-.05,1.05);axes[2].set_ylabel('Score');axes[2].set_xlabel('Hours after selected entry');axes[2].legend(fontsize=8)
        fig.suptitle(f"{i+1:02d}. {name.upper()} {item['symbol']} — {item['category']}\n{item['entry_time']} | entry label {item['label']} | entry score {score:.3f} | {'cash: entry disabled' if policy['cash'] else 'entry cutoff '+str(policy['entry_threshold'])}",fontsize=12)
        fig.text(.09,.02,'Entry dots: green=positive, red=negative, grey=unresolved. Exit path is conditional on taking this entry;\nit is not an executed portfolio trade. Selection is deliberate and hindsight-based. Fees excluded.',fontsize=9)
        fig.tight_layout(rect=[0,.06,1,.92]);filename=f'{i+1:02d}-{name}-{item["category"]}.png';fig.savefig(out/filename,dpi=120);plt.close(fig)
        record={**item,'seed':seed,'entry_score':score,'entry_policy':policy,'conditional_model_exit_step':model_step,'conditional_exit_threshold':threshold,'plot':'paths/'+filename,'exit_target_at_recovery':1 if rec else None}
        cases.append(record)
        for step,label,s in zip(steps,labels,scores):allstates.append({'case':i+1,'side':name,'symbol':item['symbol'],'entry_time':item['entry_time'],'step':int(step),'price':float(data.d.state['price'][e+step]) if np.isfinite(data.d.state['price'][e+step]) else None,'return_pct':float(ret[step]) if np.isfinite(ret[step]) else None,'exit_label':int(label),'exit_score':float(s)})
    table('path-states.csv',allstates);write('path-examples.json',{'purposeful_examples':cases,'not_representative':True,'unchanged_models_and_labels':True})
    # Exact semantics of the user's hypothetical path, mirrored for shorts.
    hypo=[]
    for sign,prices in [(1,[100,115,102,112]),(-1,[100,85,98,88])]:
        gain=sign*100*(np.array(prices)/prices[0]-1);best=int(np.argmax(gain[1:])+1)
        hypo.append({'side':'long' if sign==1 else 'short','prices':prices,'best_step':best,'labels_at_future_steps':(np.arange(1,4)>=best).astype(int).tolist(),'label_at_trough_before_recovery':int(2>=best),'future_improvement_return_points':float(gain[3]-gain[2])})
    write('label-semantics.json',{'hypothetical':hypo,'entry_rules':{'8_percent_gain':'negative even if profitable','at_least_10_but_less_than_95_percent_best':'negative','large_adverse_excursion':'not penalized or excluded by entry label','partial_future':'entire setup unresolved when any eligible candidate fails 90% future-price coverage or lacks exact deadline; the 90% criterion still permits some internal holes'},
        'exit_rule':'EXIT iff current step >= the best observed exit step from the original entry. This is a past-optimum indicator, not continuation value at the current state.'})
    print(json.dumps({'annotated_paths':len(cases),'plot_dir':str(out),'hypothetical':hypo}),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
