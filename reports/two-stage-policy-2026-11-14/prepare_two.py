"""Scan >=10% rolling24h rallies and build hindsight entry/exit teachers."""
import warnings
from common_two import *
def main():
    manifest=json.loads((HERE/'candle-manifest.json').read_text());catalog=[];events=[];offset=0;reject=collections.Counter();periods=sorted({n for pair in PAIRS for n in pair});folder=CACHE/'bars';folder.mkdir(exist_ok=True);total_eligible=0;total_positive=0;total_qualifying=0
    for period in SPEC['periods']:
        start,end=ms(period['start']),ms(period['end'])
        for record in manifest['periods'][period['id']]:
            symbol=record['symbol'];a,quality=minute_array(period,symbol);blocks=a.reshape(-1,5,5);count=np.isfinite(blocks).all(axis=2).sum(axis=1);close=blocks[:,-1,3].copy();n=len(close);key=period['id']+'-'+urllib.parse.quote(symbol,safe='');sid=len(catalog)
            with warnings.catch_warnings():
                warnings.simplefilter('ignore',RuntimeWarning);bars=np.stack([blocks[:,0,0],np.nanmax(blocks[:,:,1],axis=1),np.nanmin(blocks[:,:,2],axis=1),close,np.nansum(blocks[:,:,4],axis=1)],axis=1)
            bars[count<4]=np.nan;means=np.stack([sma(close,w) for w in periods],axis=1);execution=(np.arange(n)+1)*5+1;p=np.full(n,np.nan);valid=execution<len(a);p[valid]=a[execution[valid],0];vol=a[(np.arange(n)+1)*5-1,3]*a[(np.arange(n)+1)*5-1,4];term_px=np.full(n,np.nan);term_time=np.full(n,-1,np.int64)
            next_open=np.minimum.accumulate(np.where(np.isfinite(a[:,0]),np.arange(len(a)),len(a))[::-1])[::-1];wanted=execution+1440;valid=wanted+30<len(a);actual=np.full(n,len(a),int);actual[valid]=next_open[wanted[valid]];valid&=actual<=wanted+30;term_px[valid]=a[actual[valid],0];term_time[valid]=start+actual[valid]*MIN
            maximum,arg=future_best(p);better=np.isfinite(term_px)&((~np.isfinite(maximum))|(term_px>maximum));maximum[better]=term_px[better];arg[better]=np.arange(n)[better]+H;gain=100*(safe(maximum,p)-1);ret24=100*(safe(close,lag(close,H))-1);eligible=(vol>=SPEC['economics']['minimum_prior_minute_quote_volume_usd'])&np.isfinite(close)&(np.arange(n)>=H);entry_target=np.zeros(n,np.float32);uncertain=np.zeros(n,bool);anchor_state=np.zeros(n,bool);next_anchor=0;local=0
            qualifying=np.flatnonzero(ret24>=SPEC['rally_gain_24h_pct']);total_qualifying+=len(qualifying)
            for anchor in qualifying:
                if anchor<next_anchor:continue
                next_anchor=anchor+H;anchor_state[anchor]=True
                if start+(anchor+1)*BAR+1472*MIN>end:reject['unfinished_rally_teacher_horizon']+=1;continue
                ix=np.arange(max(H,int(anchor)-H),int(anchor)+1);possible=eligible[ix]&np.isfinite(p[ix]);valid_ix=ix[possible]
                if not len(valid_ix):reject['no_liquid_executable_teacher_entry']+=1;continue
                if not np.isfinite(term_px[valid_ix]).all():reject['unresolved_teacher_search_terminal']+=1;uncertain[ix]=True;continue
                best=int(valid_ix[np.argmax(gain[valid_ix])]);opt=float(gain[best])
                if opt<=0:reject['no_positive_executable_teacher_gain']+=1;continue
                near=valid_ix[(np.abs(valid_ix-best)<=SPEC['target_entry_tolerance_bars'])&(gain[valid_ix]>=SPEC['target_entry_relative_profit']*opt)];entry_target[near]=1;label=start+(int(anchor)+1)*BAR+1472*MIN;events.append({'id':len(events),'series':sid,'symbol':symbol,'period':period['id'],'anchor_index':offset+int(anchor),'anchor_time':iso(start+(int(anchor)+1)*BAR),'rolling24h_gain_pct':float(ret24[anchor]),'teacher_entry':offset+best,'teacher_entry_time':iso(start+(best+1)*BAR+MIN),'teacher_exit':offset+int(arg[best]),'teacher_exit_time':iso(int(term_time[best])) if arg[best]==best+H else iso(start+(int(arg[best])+1)*BAR+MIN),'teacher_gain_pct':opt,'label_available':iso(label),'positive_entry_indices':(offset+near).tolist()});local+=1
            entry_target[uncertain&(entry_target==0)]=np.nan;mature=start+(np.arange(n)+1)*BAR+(2880+32)*MIN<end;total_eligible+=int((eligible&mature&np.isfinite(entry_target)).sum());total_positive+=int(((entry_target==1)&eligible&mature).sum())
            np.savez_compressed(folder/(key+'.npz'),bars=bars,close=close,means=means,periods=periods,price=p,quote_volume=vol,terminal_price=term_px,terminal_time=term_time,best_future_price=maximum,best_future_index=arg,gain=gain,rolling24h_gain_pct=ret24,entry_target=entry_target,eligible=eligible,mature=mature,anchor_state=anchor_state)
            catalog.append({'id':sid,'key':key,'symbol':symbol,'period':period['id'],'start':period['start'],'end':period['end'],'offset':offset,'bars':n,'candidates':local,'eligible_states':int(eligible.sum()),'quality':quality});offset+=n
        print(json.dumps({'period':period['id'],'teachers':len(events),'series':len(catalog)}),flush=True)
    save('catalog.json',catalog);save('teachers.json',events,True);save('candidate-summary.json',{'teacher_rallies':len(events),'unique_teacher_entries':len({e['teacher_entry'] for e in events}),'all_qualifying_5m_observations':total_qualifying,'mature_eligible_states':total_eligible,'mature_good_entry_states':total_positive,'teacher_symbols':len({e['symbol'] for e in events}),'scanned_symbols':len({c['symbol'] for c in catalog}),'series':len(catalog),'global_states':offset,'exclusions':dict(reject),'target_rule':'24h close-to-close return >=10%; one anchor per token per24h; hindsight entry search includes prior24h; exit <=24h after entry.'});print((HERE/'candidate-summary.json').read_text())
if __name__=='__main__':main()
