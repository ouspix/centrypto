"""Match explicit asset mentions in archived headlines and descriptions."""
from collections import defaultdict
import html
import re
import unicodedata

ALIASES = {
    "BTC": ["bitcoin", "wrapped bitcoin", "satoshi nakamoto"],
    "ETH": ["ethereum"],
    "SOL": ["solana"],
    "HYPE": ["hyperliquid", "hype token", "hype perp"],
    "XRP": ["ripple labs", "ripple's xrp", "xrp ledger", "xrpl"],
    "BNB": ["bnb chain", "binance coin"],
    "DOGE": ["dogecoin"],
    "ZEC": ["zcash"],
    "XMR": ["monero"],
    "XLM": ["stellar lumens", "stellar development foundation"],
    "ADA": ["cardano"],
    "AVAX": ["avalanche network", "avalanche blockchain", "avalanche token", "ava labs"],
    "LINK": ["chainlink"],
    "DOT": ["polkadot"],
    "ATOM": ["cosmos hub", "cosmos atom", "atom token"],
    "AAVE": ["aave"],
    "ARB": ["arbitrum"],
    "OP": ["optimism network", "optimism mainnet", "optimism foundation", "op token"],
    "PUMP": ["pump.fun", "pump fun", "pump token"],
    "PAXG": ["pax gold", "paxos gold"],
    "ICP": ["internet computer", "dfinity"],
    "NEAR": ["near protocol", "near foundation", "near token", "near blockchain"],
    "SUI": ["sui network", "sui blockchain", "sui token", "sui foundation", "mysten labs"],
    "LTC": ["litecoin"],
    "BCH": ["bitcoin cash"],
    "BSV": ["bitcoin sv", "bitcoin satoshi vision"],
    "ETC": ["ethereum classic"],
    "BNT": ["bancor"],
    "TAO": ["bittensor", "tao token"],
    "HBAR": ["hedera", "hedera hashgraph"],
    "TRX": ["tron network", "tron dao", "tron blockchain", "tron token"],
    "TON": ["toncoin", "the open network", "ton foundation", "ton blockchain"],
    "TRUMP": ["official trump memecoin", "trump memecoin", "trump meme coin", "trump token"],
    "WLD": ["worldcoin", "world network", "wld token"],
    "WLFI": ["world liberty financial", "wlfi token"],
    "ONDO": ["ondo finance", "ondo token", "ondo global markets"],
    "UNI": ["uniswap"],
    "LDO": ["lido dao", "lido finance", "ldo token"],
    "ENA": ["ethena"],
    "APT": ["aptos"],
    "SEI": ["sei network", "sei blockchain", "sei foundation", "sei token", "sei labs"],
    "RENDER": ["render network", "render token", "render foundation"],
    "RNDR": ["rndr token"],
    "AI16Z": ["ai16z"],
    "VIRTUAL": ["virtuals protocol", "virtuals token"],
    "JUP": ["jupiter dex", "jupiter exchange", "jupiter aggregator", "jup token"],
    "JTO": ["jito", "jito labs"],
    "LIT": ["lighter token", "lighter dex", "lighter exchange", "lighter perpetual"],
    "ASTER": ["aster dex", "aster exchange", "aster perpetual", "aster token"],
    "MON": ["monad blockchain", "monad mainnet", "monad network", "mon token", "monad labs"],
    "XPL": ["plasma blockchain", "plasma mainnet", "plasma stablecoin", "xpl token"],
    "S": ["sonic labs", "sonic network", "sonic blockchain", "sonic token", "sonic chain"],
    "FTM": ["fantom"],
    "FARTCOIN": ["fartcoin"],
    "kPEPE": ["pepe coin", "pepe memecoin", "pepe meme coin", "pepe token", "1000pepe", "kpepe"],
    "kSHIB": ["shiba inu token", "shiba inu coin", "shiba inu", "1000shib", "kshib"],
    "kBONK": ["bonk token", "bonk meme coin", "bonk memecoin", "1000bonk", "kbonk"],
    "kFLOKI": ["floki inu", "floki token", "1000floki", "kfloki"],
    "kLUNC": ["luna classic", "terra classic", "1000lunc", "klunc"],
    "kNEIRO": ["neiro token", "neiro memecoin", "1000neiro", "kneiro"],
    "WIF": ["dogwifhat"],
    "POPCAT": ["popcat token", "popcat memecoin"],
    "PENGU": ["pudgy penguins", "pengu token"],
    "CAKE": ["pancakeswap"],
    "CRV": ["curve finance", "curve dao", "crv token"],
    "COMP": ["compound finance", "comp token"],
    "MKR": ["makerdao", "maker dao"],
    "SKY": ["sky protocol", "sky token"],
    "MORPHO": ["morpho protocol", "morpho labs", "morpho vault", "morpho token"],
    "PENDLE": ["pendle finance", "pendle protocol", "pendle token"],
    "DYDX": ["dydx"],
    "SUSHI": ["sushiswap"],
    "GMX": ["gmx protocol", "gmx token", "gmx exchange", "gmx dex"],
    "INJ": ["injective protocol", "injective labs", "injective blockchain", "injective token"],
    "ALGO": ["algorand"],
    "STRK": ["starknet", "starkware"],
    "ZK": ["zksync"],
    "ZRO": ["layerzero"],
    "STX": ["stacks network", "stacks blockchain", "stacks token"],
    "TIA": ["celestia"],
    "POL": ["polygon network", "polygon labs", "polygon blockchain", "polygon token", "pol token"],
    "MATIC": ["matic token", "matic network"],
    "FIL": ["filecoin"],
    "GALA": ["gala games", "gala token"],
    "IMX": ["immutable x", "immutable zk", "immutable games"],
    "AXS": ["axie infinity"],
    "SAND": ["sandbox metaverse", "sand token"],
    "RUNE": ["thorchain"],
    "FET": ["fetch.ai", "fetch ai"],
    "EIGEN": ["eigenlayer", "eigen token"],
    "ETHFI": ["ether.fi", "etherfi"],
    "W": ["wormhole token", "wormhole bridge", "wormhole protocol"],
    "PYTH": ["pyth network", "pyth token"],
    "BERA": ["berachain"],
    "AERO": ["aerodrome finance", "aero token"],
    "DASH": ["dash cryptocurrency", "dash coin", "dash token"],
    "ZEN": ["horizen"],
    "KAS": ["kaspa"],
    "LINEA": ["linea mainnet", "linea token", "linea network", "linea blockchain"],
    "KAITO": ["kaito ai", "kaito token"],
    "MNT": ["mantle network", "mantle blockchain", "mantle token"],
    "ZORA": ["zora network", "zora token", "zora chain"],
    "STABLE": ["stable blockchain", "stable mainnet", "stable token", "stable network"],
    "MEGA": ["megaeth"],
}
BARE = frozenset("""BTC ETH SOL XRP BNB DOGE ZEC XMR XLM ADA AVAX LTC BCH BSV ETC USDC USDT HBAR TON
 CRV AAVE LDO ENA APT SUI ICP FARTCOIN WIF PAXG TIA PYTH DYDX FIL ALGO STRK WLFI
 STX WLD GALA EIGEN ETHFI GMX KAS PEPE SHIB BONK FLOKI LUNC""".split())
CASHTAG_ALIAS = {"PEPE":"kPEPE","SHIB":"kSHIB","BONK":"kBONK","FLOKI":"kFLOKI","LUNC":"kLUNC",
                 "NEIRO":"kNEIRO"}
TAGS = re.compile(r"(?<!\w)\$([A-Za-z0-9]{1,20})(?!\w)")
TICKERS = re.compile(r"\b[A-Z][A-Z0-9]{1,15}\b")


def normalize(s):
    s=unicodedata.normalize("NFKC",html.unescape(s))
    return " ".join(s.split())


class AssetIndex:
    def __init__(self,symbols):
        self.symbols={s.upper():s for s in symbols}
        self.canonical=set(symbols)
        by_phrase=defaultdict(set)
        for symbol,terms in ALIASES.items():
            if symbol in symbols:
                for term in terms:
                    by_phrase[term].add(symbol)
        self.by_phrase=by_phrase
        # Match the longest name first when it begins at the same location.
        self.pattern=re.compile(r"(?<!\w)(?:"+"|".join(map(re.escape,sorted(by_phrase,key=lambda x:(-len(x),x))))+r")(?!\w)") if by_phrase else None

    def match(self,text):
        clean=normalize(text)
        found=set()
        if self.pattern is not None:
            for m in self.pattern.finditer(clean.casefold()):
                found.update(self.by_phrase[m.group()])
        tokens={s.upper() for s in TAGS.findall(clean)}
        tokens.update(s for s in TICKERS.findall(clean) if s in BARE)
        for t in tokens:
            symbol=CASHTAG_ALIAS.get(t) or self.symbols.get(t)
            if symbol in self.canonical:
                found.add(symbol)
        return sorted(found)
