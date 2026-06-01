import { MarketEntry } from "@/types/snapshot";

export type MarketStructure = {
    absMoveBps: {
        m15: number | null;
        h1: number | null;
        h4: number | null;
    };
    relativeMoveBps: {
        vsBtc_m15: number | null;
        vsBtc_h1: number | null;
        vsBtc_h4: number | null;
        vsMarket_m15: number | null;
        vsMarket_h1: number | null;
        vsMarket_h4: number | null;
    };
    volume: {
        recentQuoteVolume: number | null;
        relativeVolumeRatio: number | null;
        volumeSpike: boolean;
    };
    range: {
        rangeExpansionRatio: number | null;
        compressionThenExpansion: boolean;
        newHigh1h: boolean;
        newLow1h: boolean;
        newHigh4h: boolean;
        newLow4h: boolean;
        distanceFromLocalHighBps: number | null;
        distanceFromLocalLowBps: number | null;
    };
    impulse: {
        direction: "up" | "down" | "none";
        impulseBps: number;
        ageMinutes: number | null;
        followThrough: boolean;
        stalled: boolean;
    };
    participation: {
        openInterestDelta5m: number | null;
        fundingDelta5m: number | null;
        bookPressure: number | null;
    };
    optionalIndicators: {
        sma20?: number | null;
        sma50?: number | null;
        priceVsSma20Bps?: number | null;
        priceVsSma50Bps?: number | null;
    };
};

export type BenchmarkMoves = {
    btc?: Partial<Record<"m15" | "h1" | "h4", number>>;
    market?: Partial<Record<"m15" | "h1" | "h4", number>>;
};

export class MarketStructureService {
    public compute(market: MarketEntry, benchmarks: BenchmarkMoves = {}): MarketStructure {
        const retM15 = finite(market.returns?.m15);
        const retH1 = finite(market.returns?.h1);
        const retH4 = finite(market.returns?.h4);
        const impulseReturn = pickImpulseReturn(retM15, retH1, retH4);
        const impulseBps = Math.abs((impulseReturn ?? 0) * 10000);
        const direction = impulseReturn === null || Math.abs(impulseReturn) < 0.001
            ? "none"
            : impulseReturn > 0 ? "up" : "down";
        const retSigma = finite(market.vol_zscores?.ret_5m_vs_1h) ?? 0;
        const volRatio = finite(market.vol_zscores?.vol_5m_vs_1h);
        const rangeExpansion = market.discovery?.metrics.rangeExpansionRatio ??
            expansionRatio(market.realized_vol?.m5, market.realized_vol?.h1, volRatio);

        return {
            absMoveBps: {
                m15: absBps(retM15),
                h1: absBps(retH1),
                h4: absBps(retH4)
            },
            relativeMoveBps: {
                vsBtc_m15: relativeBps(retM15, benchmarks.btc?.m15),
                vsBtc_h1: relativeBps(retH1, benchmarks.btc?.h1),
                vsBtc_h4: relativeBps(retH4, benchmarks.btc?.h4),
                vsMarket_m15: relativeBps(retM15, benchmarks.market?.m15),
                vsMarket_h1: relativeBps(retH1, benchmarks.market?.h1),
                vsMarket_h4: relativeBps(retH4, benchmarks.market?.h4)
            },
            volume: {
                recentQuoteVolume: market.discovery?.metrics.recentQuoteVolume ?? null,
                relativeVolumeRatio: market.discovery?.metrics.relativeVolumeRatio ?? volRatio,
                volumeSpike: (market.discovery?.metrics.relativeVolumeRatio ?? volRatio ?? 0) >= 1.5
            },
            range: {
                rangeExpansionRatio: rangeExpansion,
                compressionThenExpansion: (rangeExpansion ?? 0) >= 1.8 && Math.abs(retSigma) >= 1,
                newHigh1h: Boolean(market.high_low?.is_new_high_1h),
                newLow1h: Boolean(market.high_low?.is_new_low_1h),
                newHigh4h: Boolean(market.high_low?.is_new_high_4h),
                newLow4h: Boolean(market.high_low?.is_new_low_4h),
                distanceFromLocalHighBps: finite(market.high_low?.distance_from_high_bps),
                distanceFromLocalLowBps: finite(market.high_low?.distance_from_low_bps)
            },
            impulse: {
                direction,
                impulseBps,
                ageMinutes: impulseBps > 0 ? 0 : null,
                followThrough: direction === "up"
                    ? retSigma > 0 && sameSign(retM15, retH1)
                    : direction === "down"
                        ? retSigma < 0 && sameSign(retM15, retH1)
                        : false,
                stalled: direction !== "none" && Math.abs(finite(market.returns?.m5) ?? 0) * 10000 < impulseBps * 0.1
            },
            participation: {
                openInterestDelta5m: finite(market.open_interest?.delta_5m),
                fundingDelta5m: finite(market.funding?.delta_5m),
                bookPressure: finite(market.orderbook?.book_pressure)
            },
            optionalIndicators: {}
        };
    }
}

function pickImpulseReturn(...returns: Array<number | null>): number | null {
    const available = returns.filter((value): value is number => value !== null);
    if (available.length === 0) return null;
    return available.reduce((best, value) => Math.abs(value) > Math.abs(best) ? value : best, available[0]);
}

function expansionRatio(realizedM5: number | null | undefined, realizedH1: number | null | undefined, volRatio: number | null): number | null {
    const realizedRatio = finite(realizedM5) !== null && finite(realizedH1) !== null && finite(realizedH1)! > 0
        ? finite(realizedM5)! / finite(realizedH1)!
        : null;
    return finite(Math.max(volRatio ?? 0, realizedRatio ?? 0));
}

function absBps(value: number | null): number | null {
    return value === null ? null : Math.abs(value) * 10000;
}

function relativeBps(value: number | null, benchmark: number | null | undefined): number | null {
    if (value === null || benchmark === null || benchmark === undefined || !Number.isFinite(benchmark)) return null;
    return (value - benchmark) * 10000;
}

function sameSign(a: number | null, b: number | null): boolean {
    if (a === null || b === null) return false;
    return Math.sign(a) !== 0 && Math.sign(a) === Math.sign(b);
}

function finite(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
