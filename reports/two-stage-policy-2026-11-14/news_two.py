"""As-of document/topic and immutable signal features, entry model only."""
import ast,re,bisect
from common_two import *
source=ast.parse((HERE.parent/'rally-reduced-2026-11-13/news.py').read_text())
CONSTANTS={n.targets[0].id:ast.literal_eval(n.value) for n in source.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id in ['ALIASES','AMBIGUOUS','TOPICS','MULTIPLIERS']}
ALIASES=CONSTANTS['ALIASES'];AMBIGUOUS=CONSTANTS['AMBIGUOUS'];TOPICS=CONSTANTS['TOPICS'];MULTIPLIERS=CONSTANTS['MULTIPLIERS']
def phrase(s,case=False):return re.compile(r'(?<![A-Za-z0-9_])'+re.escape(s)+r'(?![A-Za-z0-9_])',0 if case else re.I)
def availability(d):return max(ms(d[k]) if d.get(k) else 0 for k in ['publishedAt','collectedAt','availableAt'])
def intervals(cut,items):
    delta=np.zeros(len(cut)+1)
    for start,end,weight in items:
        if end<=start:continue
        a=np.searchsorted(cut,start,side='left');b=np.searchsorted(cut,end,side='left');delta[a]+=weight;delta[b]-=weight
    return np.cumsum(delta[:-1])
class News:
    def __init__(self,symbols):
        raw=gz(CACHE/'news-full.json.gz');self.docs={d['id']:d for d in raw['documents']};self.feed=np.array(sorted(availability(d) for d in raw['documents']),np.int64);self.index={};self.edges=[];self.market=[]
        for d in self.docs.values():
            d['_at']=availability(d);d['_pub']=ms(d['publishedAt'] or d['collectedAt']);d['_topics']={k:bool(re.search(v,d['text'],re.I)) for k,v in TOPICS.items()};d['_whale']=any(s in d['source']['name'].lower() for s in ['whale alert','lookonchain','cryptoquant','glassnode'])
            if d['_topics']['macro'] or (d['_topics']['security'] and re.search(r'binance|coinbase|bybit|okx|kraken',d['text'],re.I)):self.market.append(d)
        for symbol in symbols:
            base=symbol[1:] if symbol in MULTIPLIERS else symbol;patterns=[(re.compile(r'\$'+re.escape(base)+r'(?![A-Za-z0-9_])'),'direct')]
            if base not in AMBIGUOUS and len(base)>1:patterns.append((phrase(base,True),'direct'))
            patterns +=[(phrase(term),'project') for term in ALIASES.get(symbol,[])];seen=set();matched=[]
            for d in sorted(self.docs.values(),key=lambda d:d['_at']):
                role=next((role for p,role in patterns if p.search(d['text'])),None)
                if not role or d['storyHash'] in seen:continue
                if symbol=='BTC' and re.search(r'bitcoin\s+(cash|sv)',d['text'],re.I) and not re.search(r'\bBTC\b',d['text']):continue
                if symbol=='ETH' and re.search(r'ethereum\s+classic',d['text'],re.I) and not re.search(r'\bETH\b',d['text']):continue
                seen.add(d['storyHash']);matched.append((d,role));self.edges.append({'symbol':symbol,'document_id':d['id'],'available_at':iso(d['_at']),'published_at':iso(d['_pub']),'role':role})
            self.index[symbol]=matched
        analyses={a['id']:a for a in raw['analyses']};events=[];invalid=0
        def add(s,a,r=None):
            nonlocal invalid
            refs=[self.docs.get(i) for i in s.get('evidenceIds',[])];valid=bool(refs) and all(refs);at=max(ms(a['availableAt']),ms(r['availableAt']) if r else 0)
            if valid:at=max(at,*[d['_at'] for d in refs]);expiry=min(ms(s['expiresAt']),max(d['_pub'] for d in refs)+(4 if s.get('horizon')=='short_term' else 24)*3600000)
            else:expiry=0;invalid+=1
            events.append({'key':s['eventKey'],'at':at,'end':expiry,'s':s,'revision':r is not None})
        for a in raw['analyses']:
            for s in json.loads(a['resultJson']).get('signals',[]):add(s,a)
        for r in raw['revisions']:
            if r['analysisId'] in analyses:add(json.loads(r['detailsJson'])['signal'],analyses[r['analysisId']],r)
        grouped=collections.defaultdict(list)
        for e in sorted(events,key=lambda e:(e['at'],e['revision'])):grouped[e['key']].append(e)
        self.signals=collections.defaultdict(list)
        for ee in grouped.values():
            for j,e in enumerate(ee):
                e['end']=min(e['end'],ee[j+1]['at'] if j+1<len(ee) else e['end'])
                for s in e['s'].get('symbols',[]):self.signals[s].append(e)
        save('news-mapping.json',{'documents':len(self.docs),'asset_document_links':len(self.edges),'first_available':iso(int(self.feed.min())),'signal_revisions':len(events),'invalid_signal_evidence':invalid,'deduplication':'Earliest available capture of each storyHash per asset; deterministic frozen aliases; no future learned aliases.'});save('news-edges.json',self.edges,True)
    def features(self,symbol,cut):
        at=np.searchsorted(self.feed,cut,side='right')-1;known=(at>=0)&(cut-self.feed[np.maximum(at,0)]<=6*3600000);out={'news_feed_available':known.astype(float)};docs=self.index.get(symbol,[])
        for hours in [1,6,24]:
            for name in ['stories','direct_mentions','whale_reports',*TOPICS]:
                chosen=[d for d,role in docs if name=='stories' or (name=='direct_mentions' and role=='direct') or (name=='whale_reports' and d['_whale']) or d['_topics'].get(name,False)];v=intervals(cut,[(d['_at'],min(d['_at'],d['_pub'])+hours*3600000,1) for d in chosen]);out[f'news_{name}_{hours}h']=np.where(known,v,np.nan)
        for name in ['macro','security']:
            v=intervals(cut,[(d['_at'],min(d['_at'],d['_pub'])+24*3600000,1) for d in self.market if d['_topics'][name]]);out['news_market_'+name+'_24h']=np.where(known,v,np.nan)
        times=np.array([d['_at'] for d,_ in docs],np.int64);ix=np.searchsorted(times,cut,side='right')-1
        out['news_latest_age_hours']=np.where(ix>=0,np.minimum((cut-times[np.maximum(ix,0)])/3600000,168),np.nan) if len(times) else np.full(len(cut),np.nan)
        out['news_burst_1h_vs_24h']=safe(out['news_stories_1h'],out['news_stories_24h']/24+1)
        for direction in ['bullish','bearish','neutral']:
            chosen=[e for e in self.signals.get(symbol,[]) if e['s'].get('direction')==direction]
            out['news_signal_'+direction+'_count']=np.where(known,intervals(cut,[(e['at'],e['end'],1) for e in chosen]),np.nan)
            out['news_signal_'+direction+'_strength']=np.where(known,intervals(cut,[(e['at'],e['end'],float(e['s'].get('confidence',0))*float(e['s'].get('materiality',0))) for e in chosen]),np.nan)
        return out
