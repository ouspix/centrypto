"""Auditable, as-of raw-document links plus contemporaneous structured news signals."""
import bisect,collections,hashlib,re
from common import *
ALIASES={
 'BTC':['bitcoin','比特币','ビットコイン','비트코인'],'ETH':['ethereum','以太坊','イーサリアム','이더리움'],
 'SOL':['solana','索拉纳','솔라나'],'BNB':['binance coin'],'XRP':['ripple','瑞波币'],'DOGE':['dogecoin','狗狗币'],
 'ADA':['cardano'],'AVAX':['avalanche network','avalanche blockchain'],'DOT':['polkadot'],'LINK':['chainlink'],
 'ARB':['arbitrum'],'OP':['optimism network','optimism blockchain'],'NEAR':['near protocol'],'S':['sonic labs','sonic network'],
 'HYPE':['hyperliquid'],'SOPH':['sophon'],'INIT':['initia'],'RUNE':['thorchain'],'TIA':['celestia'],'ZEC':['zcash','大零币'],
 'AAVE':['aave'],'UNI':['uniswap'],'ENA':['ethena'],'ONDO':['ondo finance'],'PENDLE':['pendle'],
 'INJ':['injective'],'SEI':['sei network'],'SUI':['sui network','sui blockchain'],'APT':['aptos'],'STX':['stacks network'],
 'TAO':['bittensor'],'FET':['fetch.ai'],'RENDER':['render network'],'RNDR':['render network'],'GRT':['the graph'],
 'FIL':['filecoin'],'AR':['arweave'],'ICP':['internet computer'],'BCH':['bitcoin cash'],'LTC':['litecoin'],
 'XLM':['stellar network'],'ETC':['ethereum classic'],'XMR':['monero'],'XPL':['plasma blockchain'],'NIL':['nillion'],
 'GRASS':['grass network'],'ETHFI':['ether.fi'],'REZ':['renzo protocol'],'SYRUP':['maple finance'],'ZRO':['layerzero'],
 'STRK':['starknet'],'IMX':['immutable x'],'ENS':['ethereum name service'],'EIGEN':['eigenlayer'],
 'AXS':['axie infinity'],'SAND':['the sandbox'],'MANA':['decentraland'],'GALA':['gala games'],
 'WLD':['worldcoin'],'APE':['apecoin'],'JUP':['jupiter exchange'],'JTO':['jito network'],'PYTH':['pyth network'],
 'TRUMP':['official trump memecoin','trump memecoin'],'MELANIA':['melania memecoin'],
 'PUMP':['pump.fun'],'FARTCOIN':['fartcoin'],'PURR':['purr token'],'VVV':['venice token','venice ai'],
 'FTM':['fantom'],'LDO':['lido finance'],'CRV':['curve finance'],'SNX':['synthetix'],'DYDX':['dydx'],
 'KAS':['kaspa'],'ALGO':['algorand'],'ATOM':['cosmos hub'],'OSMO':['osmosis network'],'TRX':['tron network'],'TON':['toncoin','the open network']
}
AMBIGUOUS={'A','I','W','S','ME','MOVE','IP','AI','OP','NEAR','ON','IN','GAS','PUMP','TRUMP','MELANIA','APE','AR','RENDER','LIT','MEGA','GRAM','CASH','BIGTIME','MEME'}
MULTIPLIERS={'kPEPE','kSHIB','kBONK','kFLOKI','kLUNC','kDOGS','kNEIRO','kBABYDOGE'}
TOPICS={
 'listing':r'list(?:ing|ed)|delist|上币|上线|下架|상장|上場',
 'security':r'hack|exploit|theft|stolen|攻击|被盗|漏洞|해킹',
 'unlock':r'unlock|vesting|解锁|解鎖',
 'buyback_burn':r'buyback|buy back|repurchas|token burn|回购|销毁|回購',
 'regulation':r'regulat|\bsec\b|lawsuit|legislat|监管|法案|诉讼',
 'exchange_flow':r'inflow|outflow|deposit|withdraw|流入|流出|充值|提币',
 'adoption':r'adopt|partnership|integrat|合作|采用',
 'upgrade':r'upgrade|mainnet|hard fork|升级|主网|主網',
 'macro':r'macro|interest rate|federal reserve|inflation|fomc|非农|通胀|美联储|降息',
 'liquidation':r'liquidat|short squeeze|爆仓|清算|逼空',
 'etf':r'\betf\b|exchange.traded fund',
 'airdrop':r'airdrop|空投',
}

def phrase_pattern(term,case=False):
    return re.compile(r'(?<![A-Za-z0-9_])'+re.escape(term)+r'(?![A-Za-z0-9_])',0 if case else re.I)
def doc_time(d):return max(ms(d[k]) if d[k] else 0 for k in ['availableAt','collectedAt','publishedAt'])
def source_is_whale(d):return any(s in d['source']['name'].lower() for s in ['whale alert','lookonchain','cryptoquant','glassnode'])

class NewsMap:
    def __init__(self,symbols):
        raw=gz(CACHE/'news-full.json.gz');helper=module('news_context_helper',CTX/'features.py')
        self.docs,self.events,self.analysis_times=helper.prepare_news(raw);self.symbols=set(symbols);self.doc_times=sorted(doc_time(d) for d in raw['documents'])
        self.aliases={s:[(name,0,'fixed_project_name') for name in ALIASES.get(s,[])] for s in symbols};self.alias_audit=[]
        # Learned names need a contemporaneous subject-symbol link AND literal corroboration in a cited document.
        for ev in self.events:
            facts=ev['signal'].get('facts') or {};subject=facts.get('subject') or {};symbol=subject.get('symbol');name=(subject.get('name') or '').strip()
            if symbol not in self.symbols or symbol in AMBIGUOUS or len(name)<4 or len(name)>45 or name.upper()==symbol.upper():continue
            if re.search(r'\b(etf|fund|exchange|hacker|wallet|trump|treasury|foundation|bitcoin strategy)\b',name,re.I):continue
            named=phrase_pattern(name);ticker=phrase_pattern(symbol,True)
            refs=[self.docs[i] for i in ev['signal'].get('evidenceIds',[]) if i in self.docs]
            if not any(named.search(d['text']) and ticker.search(d['text']) for d in refs):continue
            if any(name.casefold()==a[0].casefold() for a in self.aliases[symbol]):continue
            self.aliases[symbol].append((name,ev['available_ms'],'earlier_structured_subject'))
            self.alias_audit.append({'symbol':symbol,'name':name,'available_ms':ev['available_ms'],'analysisId':ev['analysisId']})
        self.index=collections.defaultdict(list);self.edges=[];self.market_docs=[]
        patterns={}
        for s in symbols:
            base=s[1:] if s in MULTIPLIERS else s
            terms=[(re.compile(r'\$'+re.escape(base)+r'(?![A-Za-z0-9_])'),0,'direct_cashtag',base)]
            if base not in AMBIGUOUS and len(base)>1:terms.append((phrase_pattern(base,True),0,'direct_ticker',base))
            terms.extend((phrase_pattern(name),at,kind,name) for name,at,kind in self.aliases[s])
            patterns[s]=terms
        for d in raw['documents']:
            at=doc_time(d);published=ms(d['publishedAt'] or d['collectedAt']);text=d['text'];lower=text.lower()
            d['_at']=at;d['_published']=published;d['_topics']={k:bool(re.search(rx,lower)) for k,rx in TOPICS.items()};d['_whale']=source_is_whale(d)
            if d['_topics']['macro'] or (d['_topics']['security'] and re.search(r'binance|coinbase|bybit|okx|kraken',lower)):
                self.market_docs.append(d)
            for s,terms in patterns.items():
                matches=[]
                for pattern,alias_at,kind,term in terms:
                    match=pattern.search(text)
                    if match and s=='BTC' and term.lower()=='bitcoin' and re.match(r'bitcoin\s+(cash|sv)\b',text[match.start():],re.I):continue
                    if match and s=='ETH' and term.lower()=='ethereum' and re.match(r'ethereum\s+classic\b',text[match.start():],re.I):continue
                    if match:matches.append((max(at,alias_at),kind,term,match.start()))
                if not matches:continue
                # Earliest genuinely available relation, then direct mentions before project aliases.
                matches.sort(key=lambda x:(x[0],not x[1].startswith('direct'),x[1]));when,kind,term,pos=matches[0]
                edge={'symbol':s,'documentId':d['id'],'link_available_ms':when,'document_available_ms':at,'published_ms':published,'method':kind,'term':term,'role':'direct' if kind.startswith('direct') else 'project','snippet':text[max(0,pos-90):pos+len(term)+110]}
                self.edges.append(edge);self.index[s].append(edge)
        for s in self.index:self.index[s].sort(key=lambda x:x['link_available_ms'])
        self.times={s:[x['link_available_ms'] for x in self.index[s]] for s in self.index}
        self.market_docs.sort(key=lambda x:x['_at']);self.market_times=[d['_at'] for d in self.market_docs]

    def known(self,cut):
        i=bisect.bisect_right(self.doc_times,cut)-1
        return i>=0 and cut-self.doc_times[i]<=6*3600000

    def links(self,symbol,cut,hours=24):
        edges=self.index.get(symbol,[]);times=self.times.get(symbol,[]);stop=bisect.bisect_right(times,cut)
        start=bisect.bisect_left(times,cut-hours*3600000);latest={}
        for e in edges[start:stop]:
            d=self.docs[e['documentId']]
            if e['published_ms']<cut-hours*3600000:continue
            key=(d['source']['id'],d['externalId'])
            if key not in latest or e['document_available_ms']>latest[key]['document_available_ms']:latest[key]=e
        return list(latest.values())

    def active(self,symbol,cut):
        latest={}
        for ev in self.events:
            if ev['available_ms']>cut:break
            latest[ev['eventKey']]=ev
        return [e for e in latest.values() if e['valid_evidence'] and e['expires_ms']>cut and symbol in e['signal'].get('symbols',[])]

    def feature_row(self,symbol,cut):
        known=self.known(cut);out={'mappednews_available':float(known)};alllinks=self.links(symbol,cut);evidence=[]
        for hours in [1,6,24]:
            edges=[e for e in alllinks if e['link_available_ms']>=cut-hours*3600000 and e['published_ms']>=cut-hours*3600000]
            docs=[self.docs[e['documentId']] for e in edges];story={d['storyHash'] for d in docs}
            out[f'mappednews_stories_{hours}h']=len(story) if known else np.nan
            out[f'mappednews_sources_{hours}h']=len(set(d['source']['id'] for d in docs)) if known else np.nan
            out[f'mappednews_direct_mentions_{hours}h']=sum(e['role']=='direct' for e in edges) if known else np.nan
            out[f'mappednews_project_mentions_{hours}h']=sum(e['role']=='project' for e in edges) if known else np.nan
            for name in TOPICS:out[f'mappednews_{name}_{hours}h']=len(set(d['storyHash'] for d in docs if d['_topics'][name])) if known else np.nan
        out['mappednews_latest_age_hours']=min((cut-e['link_available_ms'])/3600000 for e in alllinks) if alllinks else np.nan
        out['mappednews_max_capture_lag_hours']=max((e['document_available_ms']-e['published_ms'])/3600000 for e in alllinks) if alllinks else np.nan
        out['mappednews_burst_1h_vs_24h']=out['mappednews_stories_1h']/(out['mappednews_stories_24h']/24+1) if known else np.nan
        # Broad market context is not a direct per-token mention.
        end=bisect.bisect_right(self.market_times,cut);start=bisect.bisect_left(self.market_times,cut-24*3600000)
        market=[d for d in self.market_docs[start:end] if d['_published']>=cut-24*3600000]
        out['mappednews_market_macro_24h']=len(set(d['storyHash'] for d in market if d['_topics']['macro'])) if known else np.nan
        out['mappednews_market_exchange_security_24h']=len(set(d['storyHash'] for d in market if d['_topics']['security'])) if known else np.nan
        flow=[]
        for e in alllinks:
            d=self.docs[e['documentId']]
            if not d['_whale']:continue
            body=d['text'].split('Quoted text:')[0];sentences=re.split(r'(?<=[.!?。])\s+',body)
            relevant=[s.lower() for s in sentences if phrase_pattern(e['term']).search(s) and not re.search(r'\b(not|never|didn.t|hasn.t)\b.{0,20}\b(bought|sold|withdrawn|deposited|dumped)\b',s,re.I)]
            support=any(re.search(r'\b(bought|purchased|accumulat\w*|withdrew|withdrawn)\b|买入|增持|提币',s) for s in relevant)
            pressure=any(re.search(r'\b(sold|dumped|deposited|net inflows?)\b|卖出|抛售|充值',s) for s in relevant)
            label='mixed' if support and pressure else 'support' if support else 'pressure' if pressure else 'neutral'
            flow.append({**e,'label':label})
        out['whale_available']=float(bool(flow))
        for label in ['support','pressure','neutral','mixed']:out['whale_'+label+'_count']=sum(x['label']==label for x in flow) if flow else np.nan
        out['whale_latest_age_hours']=min((cut-x['link_available_ms'])/3600000 for x in flow) if flow else np.nan
        out['whale_source_count']=len(set(self.docs[x['documentId']]['source']['id'] for x in flow)) if flow else np.nan
        out['whale_exchange_report_count']=sum(self.docs[x['documentId']]['_topics']['exchange_flow'] for x in flow) if flow else np.nan
        out['whale_direct_trade_report_count']=sum(x['label'] in ['support','pressure','mixed'] for x in flow) if flow else np.nan
        active=self.active(symbol,cut)
        active_doc_ids={i for ev in active for i in ev['signal'].get('evidenceIds',[])}
        out['mappednews_without_active_signal_stories_24h']=len(set(self.docs[e['documentId']]['storyHash'] for e in alllinks if e['documentId'] not in active_doc_ids)) if known else np.nan
        return out,{'direct_document_links':alllinks,'whale_reports':flow,'active_news':active,'news_known':known}

def main():
    symbols=sorted(set(e['symbol'] for e in json.loads((HERE/'events.json').read_text())))
    mapper=NewsMap(symbols)
    save('news-mapping-edges.json',mapper.edges);save('news-alias-provenance.json',mapper.alias_audit)
    summary={'documents':len(mapper.docs),'analyses':len(gz(CACHE/'news-full.json.gz')['analyses']),'asset_document_links':len(mapper.edges),'mapped_documents':len(set(e['documentId'] for e in mapper.edges)),'linked_symbols':len(mapper.index),'methods':dict(collections.Counter(e['method'] for e in mapper.edges)),'market_context_documents':len(mapper.market_docs),'learned_aliases':len(mapper.alias_audit),'earliest_news_available':iso(min(mapper.doc_times))}
    save('news-mapping-summary.json',summary);print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
