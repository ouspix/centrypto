"""Frozen lexical extraction and past-only joins to decision rows."""
from collections import Counter, defaultdict
from dataclasses import dataclass
from hashlib import sha256
import csv
import gzip
import json
import re

import numpy as np

from inputs import CACHE, HERE, UNIVERSE, AssetIndex, DAY, HOUR, MINUTE, file_hash, load, save_json
from story_archive import parsed_time

LEXICON = {
    "security": r"exploit(?:ed|s)?|hack(?:ed|s)?|breach(?:es)?|stolen funds|drained",
    "listing": r"(?:(?:binance|coinbase|kraken|okx|bybit|upbit|bitstamp|kucoin|exchange)\s+(?:(?:will|to|plans to)\s+)?lists?\b|(?:trad(?:ing|e)|spot|exchange|perpetual|token|coin|pair)\s+listings?\b|(?:listed|lists?|listing)\s+on\s+(?:the exchange|binance|coinbase|kraken|okx|bybit|upbit|bitstamp|kucoin)|launch(?:es|ed)?\s+(?:spot\s+|perpetual\s+)?trading)",
    "delisting": r"delist(?:ing|ed|s)?|suspend(?:s|ed)? trading",
    "supply": r"token unlocks?|vesting|token burns?|token issuance|supply cuts?",
    "regulatory": r"lawsuit|subpoena|regulat(?:or|ion|ory)|indict(?:ed|ment)|enforcement|sec filing",
    "uncertain": r"alleg(?:ed|edly|ations?)|rumou?rs?|unconfirmed|reportedly|investigating",
    "confirmed_word": r"confirm(?:s|ed|ation)?|verified|officially",
    "correction": r"retract(?:ed|s|ion)?|correct(?:s|ed|ion)|den(?:y|ies|ied)",
    "resolved": r"resolved|restored|resum(?:ed|es)|patched|recovered funds",
    "macro": r"federal reserve|fed rate|interest rates?|inflation|treasury yields?|rate cuts?|crypto market|cryptocurrency market|stablecoin supply",
}
REGEX = {k:re.compile(r"\b(?:"+v+r")\b",re.I) for k,v in LEXICON.items()}
TYPES = list(LEXICON)[:5]
OFFICIAL = {"sec.gov","cftc.gov","justice.gov","federalreserve.gov","esma.europa.eu"}
SKIP = set("about after again amid before could crypto from have into latest more news over says than that their this today with would".split())
AVAIL = ["recent_archive","pending_crypto_article","processed_crypto_4h","processed_asset_4h"]
CONTENT = ["asset_articles","headline_mentions","asset_domains","fresh_asset_30m","asset_recency","event_clusters",
           "multi_outlet_cluster","official_domain",*TYPES,"uncertain","confirmed_word","correction","resolved",
           "macro_articles","typed_event_x_return_60m","fresh_x_volume_ratio_60m","macro_x_relative_btc_60m"]
DELAY = 15*MINUTE

@dataclass(frozen=True)
class Story:
    at:int
    expiry:int
    domain:str
    assets:tuple
    head:frozenset
    tags:frozenset
    cluster:str

class News:
    def __init__(self, audit=False):
        manifest=load(HERE/"news-inputs.json")
        path=CACHE/"stories.jsonl.gz"
        assert file_hash(path)==manifest["article_sha256"] and file_hash(CACHE/"batches.npy")==manifest["batches_sha256"]
        self.batches=np.load(CACHE/"batches.npy")
        self.by_asset=defaultdict(list)
        self.macro=[]
        self.all=[]
        self.received=[]
        self.expires=[]
        index=AssetIndex(UNIVERSE)
        buckets=defaultdict(list)
        tally=Counter()
        stream=gzip.open(CACHE/"extractions.jsonl.gz","wt") if audit else None
        try:
            with gzip.open(path,"rt") as fp:
                for line in fp:
                    r=json.loads(line)
                    at,expiry=map(parsed_time,(r["available_utc"],r["expiry_utc"]))
                    if expiry<=at:
                        continue
                    title,desc=r["title"],r["description"]
                    head=frozenset(index.match(title))
                    tags=frozenset(k for k,p in REGEX.items() if p.search(title+" "+desc))
                    typed=tuple(k for k in TYPES if k in tags)
                    terms=set(re.findall(r"[a-z0-9]{3,}",title.casefold()))-SKIP
                    group=""
                    if typed:
                        key=typed,tuple(sorted(head)) or tuple(r["asset_symbols"])
                        candidates=[g for g in buckets[key] if g[0]>at-DAY]
                        for first,words,old in candidates:
                            both=terms & words
                            if len(both)>=3 and len(both)>=.60*len(terms|words):
                                group=old
                                break
                        if not group:
                            group=r["article_id"]
                            candidates.append((at,terms,group))
                        buckets[key]=candidates
                    asset=tuple(r["asset_symbols"])
                    s=Story(at,expiry,r["domain"],asset,head,tags,group)
                    self.all.append(at)
                    self.received.append(at-DELAY)
                    self.expires.append(min(at+4*HOUR+1,expiry))
                    for sym in asset:
                        self.by_asset[sym].append(s)
                    if "macro" in tags:
                        self.macro.append(s)
                    if stream:
                        stream.write(json.dumps(dict(id=r["article_id"],ready=at,expiry=expiry,assets=asset,
                            headline=sorted(head),tags=sorted(tags),cluster=group,domain=s.domain))+"\n")
                    tally["timely_stories"]+=1
                    tally["typed_stories"]+=bool(typed)
        finally:
            if stream:
                stream.close()
        self.received=np.asarray(self.received)
        self.all=np.asarray(self.all)
        self.expires=np.sort(self.expires)
        self.macro_starts=np.array([s.at for s in self.macro])
        self.macro_ends=np.sort([min(s.at+4*HOUR+1,s.expiry) for s in self.macro])
        self.asset_starts={k:np.array([s.at for s in v]) for k,v in self.by_asset.items()}

    def values(self,symbol,times):
        times,inv=np.unique(times,return_inverse=True)
        def counts(starts,ends):
            return np.searchsorted(starts,times,"right")-np.searchsorted(ends,times,"right")
        covered=counts(self.batches,self.batches+HOUR+1)>0
        incoming=counts(self.received,self.all)>0
        processed=counts(self.all,self.expires)>0
        macro=np.log1p(counts(self.macro_starts,self.macro_ends))
        stories=self.by_asset[symbol]
        starts=self.asset_starts.get(symbol,[])
        left=np.searchsorted(starts,times-4*HOUR,"left")
        right=np.searchsorted(starts,times,"right")
        out=np.zeros((len(times),len(AVAIL)+len(CONTENT)-3))
        for i,t in enumerate(times):
            active=[s for s in stories[left[i]:right[i]] if s.expiry>t]
            direct=[s for s in active if symbol in s.head]
            events=defaultdict(set)
            tags=Counter()
            for s in direct:
                tags.update(s.tags)
                if s.cluster:
                    events[s.cluster].add(s.domain)
            fresh=int(bool(active and active[-1].at>=t-30*MINUTE))
            recency=1-(t-active[-1].at)/(4*HOUR) if active else 0.
            official=sum(any(s.domain==d or s.domain.endswith("."+d) for d in OFFICIAL) for s in direct)
            values=[np.log1p(len(active)),np.log1p(len(direct)),np.log1p(len({s.domain for s in active})),
                fresh,recency,np.log1p(len(events)),np.log1p(sum(len(v)>1 for v in events.values())),np.log1p(official),
                *(np.log1p(tags[k]) for k in list(LEXICON)[:-1]),macro[i]]
            out[i,:4]=[covered[i],incoming[i],processed[i],bool(active)]
            out[i,4:]=values if covered[i] else np.nan
        return out[inv]

    def join(self,at,assets,x,columns):
        result=np.empty((len(at),len(AVAIL)+len(CONTENT)))
        for sym in np.unique(assets):
            idx=np.flatnonzero(assets==sym)
            result[idx,:-3]=self.values(sym,at[idx])
        def col(name):
            return result[:,(AVAIL+CONTENT).index(name)]
        def interaction(signal,name):
            return np.where(signal==0,0.,signal*x[:,columns.index(name)])
        result[:,-3]=interaction(col("event_clusters"),"perp_return_pct_60m")
        result[:,-2]=interaction(col("fresh_asset_30m"),"perp_volume_ratio_60m")
        result[:,-1]=interaction(col("macro_articles"),"relative_btc_return_60m")
        return result
