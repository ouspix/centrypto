import { hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import { hyperliquidInfoPost } from "@/lib/rate-limit/hyperliquid-limiter";

export type DeskInstrument = {
    id: string;
    asset: number;
    coin: string;
    base: string;
    quote: string;
    kind: "spot" | "perp";
    szDecimals: number;
    isTestnet: boolean;
    multiplier: number;
    tokenId: string | null;
    baseTokenIndex?: number;
    quoteTokenIndex?: number;
    evmContract: string | null;
};
type Perp = { name: string; szDecimals: number; isDelisted?: boolean };
type Token = { index: number; name: string; szDecimals: number; tokenId: string; evmContract?: { address: string } | null };
type SpotMeta = { tokens: Token[]; universe: { name: string; index: number; tokens: number[] }[] };

// The k-prefix on native meme contracts means one contract represents 1,000
// units. Preserve the venue coin for prices, quantities and orders.
const multiplierCoins = new Set(["kPEPE", "kSHIB", "kBONK", "kFLOKI", "kLUNC", "kDOGS", "kNEIRO", "kBABYDOGE"]);
export function nativeInstruments(isTestnet: boolean, perps: Perp[], spot: SpotMeta): DeskInstrument[] {
    const network = isTestnet ? "testnet" : "mainnet";
    const instruments: DeskInstrument[] = [];
    perps.forEach((perp, asset) => {
        if (perp.isDelisted || !perp.name || perp.name.includes(":") || !Number.isInteger(perp.szDecimals)) return;
        const multiplier = multiplierCoins.has(perp.name) ? 1000 : 1;
        instruments.push({ id: `${network}:perp:${perp.name}`, asset, coin: perp.name, base: multiplier === 1000 ? perp.name.slice(1) : perp.name,
            quote: "USDC", kind: "perp", szDecimals: perp.szDecimals, isTestnet, multiplier, tokenId: null, evmContract: null });
    });
    const tokens = new Map(spot.tokens.map(token => [token.index, token]));
    for (const pair of spot.universe) {
        const [base, quote] = pair.tokens.map(index => tokens.get(index));
        if (!base || !quote || !pair.name || !base.tokenId || !Number.isSafeInteger(pair.index) || pair.index < 0) continue;
        instruments.push({ id: `${network}:spot:${pair.index}`, asset: 10000 + pair.index, coin: pair.name, base: base.name, quote: quote.name,
            kind: "spot", szDecimals: base.szDecimals, isTestnet, multiplier: 1, tokenId: base.tokenId, baseTokenIndex: base.index, quoteTokenIndex: quote.index, evmContract: base.evmContract?.address ?? null });
    }
    return instruments;
}

export async function listInstruments(isTestnet: boolean): Promise<DeskInstrument[]> {
    const url = hyperliquidInfoUrl(isTestnet);
    const options = { ttlMs: 5_000, allowStale: false };
    const [perps, spot] = await Promise.all([
        hyperliquidInfoPost<{ universe: Perp[] }>("hl:info:deskMeta", url, { type: "meta" }, options),
        hyperliquidInfoPost<SpotMeta>("hl:info:spotMeta", url, { type: "spotMeta" }, options)
    ]);
    if (!Array.isArray(perps?.universe) || !Array.isArray(spot?.tokens) || !Array.isArray(spot?.universe)) throw new Error("Incomplete Hyperliquid instrument registry");
    return nativeInstruments(isTestnet, perps.universe, spot);
}

// Exact ID resolution is required for execution. Discovery may return several
// pairs of the SAME underlying. Different tokens sharing a ticker are ambiguous.
export function resolveDeskExposure(instruments: DeskInstrument[], symbol: string, contract: string | null, kind: "asset" | "spot" | "perp" = "asset", quote?: string | null) {
    const ticker = symbol.toUpperCase();
    const matches = instruments.filter(i => (kind === "asset" || kind === i.kind) && (!quote || i.quote.toUpperCase() === quote.toUpperCase()) &&
        (i.base.toUpperCase() === ticker || (i.kind === "perp" && i.coin.toUpperCase() === ticker)));
    if (contract) {
        const address = contract.toLowerCase();
        return matches.filter(i => [i.tokenId, i.evmContract].some(value => value?.toLowerCase() === address));
    }
    const ids = new Set(matches.filter(i => i.kind === "spot").map(i => i.tokenId));
    if (ids.size > 1) return [];
    return matches;
}

export function quoteUsdRates(instruments: DeskInstrument[], marks: Map<string, number>) {
    const tokenUsd = new Map<number, number>([[0, 1]]);
    // Resolve spot crosses in USD by token index, not ticker; canonical USDC has index 0.
    for (let hop = 0; hop < 3; hop++)
        for (const i of instruments) {
            if (i.kind !== "spot" || !marks.has(i.id)) continue;
            const rate = tokenUsd.get(i.quoteTokenIndex!);
            if (rate && !tokenUsd.has(i.baseTokenIndex!)) tokenUsd.set(i.baseTokenIndex!, rate * marks.get(i.id)!);
        }
    return tokenUsd;
}
