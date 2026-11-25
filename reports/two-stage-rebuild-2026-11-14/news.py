"""As-of, asset-relevant structured news; no ticker matching or market broadcast."""
import re
from common import *

DIRECTIONS=['bullish','bearish','mixed','neutral','unspecified']
CLAIMS=['confirmed_announcement','reported_claim','rumor','opinion']
CHANNELS=['supply','demand','cashflow','settlement','liquidity','collateral','capacity','rates']
IMPACTS=['operational_risk','catalyst','scheduled','background']
CHANGES=['announcement','update','repeat','correction','retraction','resolution']
MULTIPLIERS={'kPEPE','kSHIB','kBONK','kFLOKI','kLUNC','kDOGS','kNEIRO','kBABYDOGE'}
# Fixed before training, never fitted to future categories or returns.
TOPICS={
 'listing':r'listing|delist|exchange_access', 'security':r'security|hack|exploit|theft|cyber',
 'unlock':r'unlock|vesting', 'buyback_burn':r'buyback|buy_back|repurchas|burn',
 'regulation':r'regulat|legal|lawsuit|policy|legislat', 'exchange_flow':r'exchange_flow|onchain_flow|onchain_transfer|deposit|withdraw',
 'adoption':r'adopt|partnership|integrat|ecosystem|product', 'upgrade':r'upgrade|protocol_develop|mainnet|hard_fork',
 'macro':r'macro|interest_rate|inflation|monetary|federal_reserve',
 'liquidation':r'liquidat|squeeze|leveraged_position|derivatives_position',
 'etf':r'etf|exchange_traded_fund', 'airdrop':r'airdrop'
}

def availability(d):
    return max(ms(d[k]) if d.get(k) else 0 for k in ['publishedAt','collectedAt','availableAt'])

def canonical_event_key(key):
    # Match lib/news/validation.ts; analyses contain raw keys, revisions hashed keys.
    return key if re.fullmatch(r'[a-f0-9]{48}',key) else hashlib.sha256(key.encode('utf-8')).hexdigest()[:48]

def intervals(cut,items):
    delta=np.zeros(len(cut)+1)
    for start,end,weight in items:
        if end<=start:continue
        a=np.searchsorted(cut,start,side='left');b=np.searchsorted(cut,end,side='left')
        delta[a]+=weight;delta[b]-=weight
    return np.cumsum(delta[:-1])

def recent_known(times,cut):
    if not len(times):return np.zeros(len(cut),bool)
    pos=np.searchsorted(times,cut,side='right')-1
    return (pos>=0)&(cut-times[np.maximum(pos,0)]<=6*3600000)

class News:
    def __init__(self,symbols,raw=None):
        if raw is None:raw=gz(BASE_CACHE/'news-full.json.gz')
        self.docs={d['id']:d for d in raw['documents']}
        self.feed=np.array(sorted(availability(d) for d in self.docs.values()),np.int64)
        self.analysis_times=np.array(sorted(ms(a['availableAt']) for a in raw['analyses']),np.int64)
        self.schema_times=[];self.index=collections.defaultdict(list);self.audit=collections.Counter();self.edges=[]
        universe=collections.defaultdict(set)
        for s in symbols:
            universe[s.upper()].add(s)
            if s in MULTIPLIERS:universe[s[1:].upper()].add(s)
        analyses={a['id']:a for a in raw['analyses']};raw_events=[]
        for a in raw['analyses']:
            signals=json.loads(a['resultJson']).get('signals',[])
            self.schema_times.append((ms(a['availableAt']),sum(bool(s.get('facts')) for s in signals),len(signals)))
            for s in signals:raw_events.append((a,None,s))
        for r in raw['revisions']:
            if r['analysisId'] in analyses:raw_events.append((analyses[r['analysisId']],r,json.loads(r['detailsJson'])['signal']))
        grouped=collections.defaultdict(list)
        for a,r,s in raw_events:
            s={**s,'eventKey':canonical_event_key(s['eventKey'])}
            refs=[self.docs.get(k) for k in s.get('evidenceIds',[])]
            at=max(ms(a['availableAt']),ms(r['availableAt']) if r else 0)
            valid=bool(refs) and all(refs)
            details=json.loads(r['detailsJson']) if r else {}
            if valid:
                at=max(at,*[availability(d) for d in refs])
                pub=min(ms(d['publishedAt'] or d['collectedAt']) for d in refs)
                if details.get('publishedAt'):pub=min(pub,ms(details['publishedAt']))
                expiry=min(ms(s['expiresAt']),pub+(4 if s.get('horizon')=='short_term' else 24)*3600000)
            else:
                pub=at;expiry=at;self.audit['missing_evidence_revisions']+=1
            grouped[s['eventKey']].append({'at':at,'pub':pub,'end':expiry,'s':s,'revision':r is not None,'details':details,'valid':valid})
        for key,versions in grouped.items():
            # Prefer the immutable normalized revision when both were available together.
            same_time={}
            for e in sorted(versions,key=lambda e:(e['at'],e['revision'])):same_time[e['at']]=e
            ee=list(same_time.values());prior=None
            for j,e in enumerate(ee):
                s=e['s'];facts=s.get('facts') or {};same=prior is not None and (facts.get('change')=='repeat' or (facts.get('factKey') and facts.get('factKey')==(prior['s'].get('facts') or {}).get('factKey')))
                if same:e['pub']=min(e['pub'],prior['pub']);e['end']=min(e['end'],prior['expiry'])
                e['expiry']=e['end'];e['end']=min(e['end'],ee[j+1]['at'] if j+1<len(ee) else e['end']);prior=e
                self.audit['event_revisions']+=1
                if not facts:self.audit['revisions_without_asset_schema']+=1;continue
                if not e['valid'] or e['end']<=e['at']:self.audit['expired_or_invalid_revisions']+=1;continue
                targets=[];subject=(facts.get('subject') or {}).get('symbol')
                for t in facts.get('targets',[]):
                    reason=None
                    if t.get('relation') not in ['direct','indirect']:reason='non_asset_relation'
                    elif not t.get('symbol') or not t.get('mechanism','').strip() or t.get('channel') not in CHANNELS:reason='missing_causal_mechanism'
                    elif t.get('instrumentKind') not in ['asset','perp']:reason='spot_only_instrument'
                    elif t['relation']=='direct' and subject and t['symbol'].upper()!=subject.upper():reason='direct_subject_mismatch'
                    elif t['symbol'].upper() not in universe:reason='outside_recorded_universe'
                    if reason:self.audit['excluded_target_'+reason]+=1
                    else:targets.append(t)
                asset_targets=collections.defaultdict(list)
                for t in targets:
                    for symbol in universe[t['symbol'].upper()]:asset_targets[symbol].append(t)
                category=re.sub(r'[^a-z0-9]+','_',s.get('category','').lower())
                topics={name for name,pattern in TOPICS.items() if re.search(pattern,category)} or {'other'}
                for symbol,matched in asset_targets.items():
                    direct=any(t['relation']=='direct' for t in matched)
                    explicit_direction=direct and (bool(subject) or len(asset_targets)==1)
                    direction=s.get('direction') if explicit_direction else 'unspecified'
                    if direction not in DIRECTIONS:direction='unspecified'
                    item={**e,'key':key,'symbol':symbol,'direction':direction,'topics':topics,
                          'channels':{t['channel'] for t in matched},'direct':direct,'indirect':any(t['relation']=='indirect' for t in matched),
                          'confidence':float(s['confidence']),'materiality':float(s['materiality']),
                          'contradictions':bool(s.get('contradictions'))}
                    self.index[symbol].append(item)
                    self.edges.append({'symbol':symbol,'event_key':key,'available_at':iso(e['at']),'published_at':iso(e['pub']),
                                       'end_at':iso(e['end']),'direction':direction,'relations':sorted({t['relation'] for t in matched}),
                                       'channels':sorted(item['channels']),'evidence_ids':s['evidenceIds']})
                    self.audit['mapped_asset_event_revisions']+=1
        self.audit['documents']=len(self.docs);self.audit['unique_event_keys']=len(grouped)
        self.audit['assets_with_news']=len(self.index)

    def features(self,symbol,cut):
        doc_known=recent_known(self.feed,cut);analysis_known=recent_known(self.analysis_times,cut);known=doc_known&analysis_known
        out={'news_feed_available':known.astype(float),'news_analysis_available':analysis_known.astype(float)}
        num=intervals(cut,[(t,t+6*3600000,n) for t,n,total in self.schema_times]);den=intervals(cut,[(t,t+6*3600000,total) for t,n,total in self.schema_times])
        out['news_structured_mapping_coverage_6h']=np.where(known,safe(num,den),np.nan)
        events=self.index.get(symbol,[])
        def total(selected,hours,weight=lambda e:1):
            return intervals(cut,[(e['at'],min(e['end'],e['pub']+hours*3600000),weight(e)) for e in selected])
        def put(name,v):out[name]=np.where(known,v,np.nan)
        for h in [1,6,24]:
            put(f'news_events_{h}h',total(events,h))
            for direction in DIRECTIONS:
                selected=[e for e in events if e['direction']==direction];count=total(selected,h)
                put(f'news_{direction}_count_{h}h',count)
                put(f'news_{direction}_strength_{h}h',total(selected,h,lambda e:e['confidence']*e['materiality']))
                for field in ['confidence','materiality']:
                    put(f'news_{direction}_{field}_mean_{h}h',np.divide(total(selected,h,lambda e:e[field]),count,out=np.zeros(len(cut)),where=count>0))
            for topic in [*TOPICS,'other']:put(f'news_topic_{topic}_present_{h}h',(total([e for e in events if topic in e['topics']],h)>0).astype(float))
            for claim in CLAIMS:put(f'news_claim_{claim}_present_{h}h',(total([e for e in events if e['s'].get('claimType')==claim],h)>0).astype(float))
            for channel in CHANNELS:put(f'news_channel_{channel}_present_{h}h',(total([e for e in events if channel in e['channels']],h)>0).astype(float))
            for relation in ['direct','indirect']:put(f'news_relation_{relation}_count_{h}h',total([e for e in events if e[relation]],h))
            put(f'news_conflicting_events_{h}h',total([e for e in events if e['contradictions']],h))
        for field,values in [('impact',IMPACTS),('change',CHANGES)]:
            for value in values:put(f'news_{field}_{value}_present_24h',(total([e for e in events if e['s']['facts'].get(field)==value],24)>0).astype(float))
        times=np.array(sorted({e['at'] for e in events}),np.int64)
        if len(times):
            i=np.searchsorted(times,cut,side='right')-1
            out['news_latest_relevant_age_hours']=np.where(known&(i>=0),np.minimum((cut-times[np.maximum(i,0)])/3600000,168),np.nan)
        else:out['news_latest_relevant_age_hours']=np.full(len(cut),np.nan)
        return out
