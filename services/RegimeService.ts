import { GlobalRegime, MarketEntry } from "@/types/snapshot";

type RegimeServiceOptions = {
    minValidSymbols?: number;
    retSigmaActiveThreshold?: number;
    maxVolRatio?: number;
    riskOnMajorsBreadthMin?: number;
    riskOnTotalBreadthMin?: number;
    riskOnVolRatioMin?: number;
    riskOffMajorsBreadthMax?: number;
    riskOffTotalBreadthMax?: number;
    riskOffVolRatioMin?: number;
    chopTotalBreadthAbsMax?: number;
    confirmationsRequired?: number;
    immediateRiskOffTotalBreadth?: number;
    immediateRiskOffMajorsBreadth?: number;
    immediateRiskOffVolZ?: number;
};

type ValidMarket = {
    symbol: string;
    market: MarketEntry;
    group: "major" | "core" | "alt";
    directionScore: number;
    volZ: number;
    weight: number;
};

const DEFAULT_OPTIONS: Required<RegimeServiceOptions> = {
    minValidSymbols: 15,
    retSigmaActiveThreshold: 0.5,
    maxVolRatio: 8,
    riskOnMajorsBreadthMin: 0.35,
    riskOnTotalBreadthMin: 0.25,
    riskOnVolRatioMin: 0.9,
    riskOffMajorsBreadthMax: -0.35,
    riskOffTotalBreadthMax: -0.25,
    riskOffVolRatioMin: 0.9,
    chopTotalBreadthAbsMax: 0.25,
    confirmationsRequired: 2,
    immediateRiskOffTotalBreadth: -0.65,
    immediateRiskOffMajorsBreadth: -0.65,
    immediateRiskOffVolZ: 1.2,
};

export class RegimeService {
    private readonly options: Required<RegimeServiceOptions>;
    private confirmedRegime: GlobalRegime["current"] = "CHOP";
    private pendingRegime: GlobalRegime["current"] | null = null;
    private pendingCount = 0;

    constructor(options: RegimeServiceOptions = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    public infer(markets: Record<string, MarketEntry>): GlobalRegime {
        const entries = this.validEntries(markets);
        if (entries.length === 0) {
            this.resetState();
            return {
                current: "CHOP",
                score: 0,
                reason: "CHOP: no valid market data"
            };
        }

        const stats = this.computeStats(entries);
        const raw = this.classify(stats, markets);
        return this.applyHysteresis(raw, stats);
    }

    private validEntries(markets: Record<string, MarketEntry>): ValidMarket[] {
        return Object.entries(markets)
            .filter(([, market]) =>
                Number.isFinite(market?.returns?.m15) &&
                Number.isFinite(market?.returns?.h1) &&
                Number.isFinite(market?.vol_zscores?.vol_5m_vs_1h) &&
                market.vol_zscores.vol_5m_vs_1h <= this.options.maxVolRatio
            )
            .map(([symbol, market]) => ({
                symbol,
                market,
                group: market.regime?.group ?? "alt",
                directionScore: this.directionScore(market),
                volZ: market.vol_zscores.vol_5m_vs_1h,
                weight: market.regime?.weight ?? this.liquidityWeight(market)
            }));
    }

    private computeStats(entries: ValidMarket[]) {
        let activeUpCount = 0;
        let activeDownCount = 0;
        let signedWeight = 0;
        let totalWeight = 0;
        let majorSignedWeight = 0;
        let majorWeight = 0;
        let coreSignedWeight = 0;
        let coreWeight = 0;
        let altSignedWeight = 0;
        let altWeight = 0;
        let weightedVolZ = 0;
        const volValues: number[] = [];

        for (const entry of entries) {
            totalWeight += entry.weight;
            signedWeight += entry.weight * entry.directionScore;
            weightedVolZ += entry.weight * entry.volZ;
            volValues.push(entry.volZ);

            if (entry.directionScore > this.options.retSigmaActiveThreshold) {
                activeUpCount++;
            } else if (entry.directionScore < -this.options.retSigmaActiveThreshold) {
                activeDownCount++;
            }

            if (entry.group === "major") {
                majorWeight += entry.weight;
                majorSignedWeight += entry.weight * entry.directionScore;
            } else if (entry.group === "core") {
                coreWeight += entry.weight;
                coreSignedWeight += entry.weight * entry.directionScore;
            } else {
                altWeight += entry.weight;
                altSignedWeight += entry.weight * entry.directionScore;
            }
        }

        const breadth = totalWeight > 0 ? signedWeight / totalWeight : 0;
        const majorsBreadth = majorWeight > 0 ? majorSignedWeight / majorWeight : 0;
        const coreBreadth = coreWeight > 0 ? coreSignedWeight / coreWeight : 0;
        const altBreadth = altWeight > 0 ? altSignedWeight / altWeight : 0;
        const avgVolZ = this.mean(volValues);
        const weightedVolZMean = totalWeight > 0 ? weightedVolZ / totalWeight : 0;
        const medianVolZ = this.median(volValues);
        const trimmedVolZ = this.trimmedMean(volValues, 0.1);
        const effectiveVolZ = Math.max(weightedVolZMean, medianVolZ, trimmedVolZ);
        const directionalStrength = Math.abs(breadth);
        const confidence = Math.min(1, directionalStrength * Math.max(0.25, effectiveVolZ));

        return {
            count: entries.length,
            activeUpCount,
            activeDownCount,
            breadth,
            majorsBreadth,
            coreBreadth,
            altBreadth,
            avgVolZ,
            weightedVolZMean,
            medianVolZ,
            trimmedVolZ,
            effectiveVolZ,
            confidence
        };
    }

    private classify(
        stats: ReturnType<RegimeService["computeStats"]>,
        _markets: Record<string, MarketEntry>
    ): GlobalRegime {
        let regime: GlobalRegime["current"] = "CHOP";
        let reason = this.formatReason("CHOP", "mixed signals or low activity", stats);

        if (stats.count < this.options.minValidSymbols) {
            return {
                current: "CHOP",
                score: this.score(stats),
                reason: this.formatReason("CHOP", `insufficient valid regime universe (${stats.count}/${this.options.minValidSymbols})`, stats)
            };
        }

        if (
            stats.majorsBreadth > this.options.riskOnMajorsBreadthMin &&
            stats.breadth > this.options.riskOnTotalBreadthMin &&
            stats.effectiveVolZ > this.options.riskOnVolRatioMin
        ) {
            regime = "RISK_ON";
            reason = this.formatReason("RISK_ON", "BTC/ETH, core breadth, liquid alt participation, and volatility confirm upside", stats);
        } else if (
            stats.majorsBreadth < this.options.riskOffMajorsBreadthMax &&
            stats.breadth < this.options.riskOffTotalBreadthMax &&
            stats.effectiveVolZ > this.options.riskOffVolRatioMin
        ) {
            regime = "RISK_OFF";
            reason = this.formatReason("RISK_OFF", "BTC/ETH, core breadth, liquid alt participation, and volatility confirm downside", stats);
        } else if (Math.abs(stats.breadth) <= this.options.chopTotalBreadthAbsMax) {
            reason = this.formatReason("CHOP", "total weighted breadth inside chop band", stats);
        }

        return {
            current: regime,
            score: this.score(stats),
            reason
        };
    }

    private applyHysteresis(
        raw: GlobalRegime,
        stats: ReturnType<RegimeService["computeStats"]>
    ): GlobalRegime {
        const shockRiskOff = raw.current === "RISK_OFF" &&
            stats.breadth <= this.options.immediateRiskOffTotalBreadth &&
            stats.majorsBreadth <= this.options.immediateRiskOffMajorsBreadth &&
            stats.effectiveVolZ >= this.options.immediateRiskOffVolZ;

        if (raw.current === "CHOP" || shockRiskOff) {
            this.confirmedRegime = raw.current;
            this.pendingRegime = null;
            this.pendingCount = 0;
            return raw;
        }

        if (raw.current === this.confirmedRegime) {
            this.pendingRegime = null;
            this.pendingCount = 0;
            return raw;
        }

        if (this.pendingRegime === raw.current) {
            this.pendingCount++;
        } else {
            this.pendingRegime = raw.current;
            this.pendingCount = 1;
        }

        if (this.pendingCount >= this.options.confirmationsRequired) {
            this.confirmedRegime = raw.current;
            this.pendingRegime = null;
            this.pendingCount = 0;
            return raw;
        }

        return {
            current: this.confirmedRegime,
            score: raw.score,
            reason: `${raw.reason}; pending ${raw.current} confirmation ${this.pendingCount}/${this.options.confirmationsRequired}`
        };
    }

    private liquidityWeight(market: MarketEntry): number {
        const bid = market.orderbook?.bid_liquidity_usd ?? 0;
        const ask = market.orderbook?.ask_liquidity_usd ?? 0;
        const minDepth = Math.max(0, Math.min(bid, ask));
        if (minDepth <= 0) return 1;
        return Math.max(0.1, Math.min(0.5, Math.sqrt(minDepth / 25_000) * 0.25));
    }

    private directionScore(market: MarketEntry): number {
        const vol15 = this.windowSigma(market.realized_vol?.h1, 15);
        const vol1h = this.windowSigma(market.realized_vol?.h1, 60);
        const vol4h = this.windowSigma(market.realized_vol?.h4 ?? market.realized_vol?.h1, 240);

        const score15m = vol15 > 0 ? market.returns.m15 / vol15 : this.fixedReturnScore(market.returns.m15);
        const score1h = vol1h > 0 ? market.returns.h1 / vol1h : this.fixedReturnScore(market.returns.h1);
        const score4h = vol4h > 0 && Number.isFinite(market.returns.h4)
            ? market.returns.h4! / vol4h
            : 0;

        return this.clamp((0.5 * this.clamp(score15m, -1, 1)) +
            (0.35 * this.clamp(score1h, -1, 1)) +
            (0.15 * this.clamp(score4h, -1, 1)), -1, 1);
    }

    private windowSigma(perMinuteVol: number | undefined, minutes: number): number {
        if (!Number.isFinite(perMinuteVol) || !perMinuteVol || perMinuteVol <= 0) return 0;
        return perMinuteVol * Math.sqrt(minutes);
    }

    private fixedReturnScore(ret: number): number {
        if (!Number.isFinite(ret)) return 0;
        return this.clamp(ret / 0.002, -1, 1);
    }

    private clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value));
    }

    private score(stats: ReturnType<RegimeService["computeStats"]>): number {
        return parseFloat((stats.confidence * Math.sign(stats.breadth)).toFixed(4));
    }

    private formatReason(
        regime: GlobalRegime["current"],
        detail: string,
        stats: ReturnType<RegimeService["computeStats"]>
    ): string {
        return `${regime}: ${detail}; totalBreadth=${stats.breadth.toFixed(3)}, majorsBreadth=${stats.majorsBreadth.toFixed(3)}, coreBreadth=${stats.coreBreadth.toFixed(3)}, altBreadth=${stats.altBreadth.toFixed(3)}, avgVolZ=${stats.avgVolZ.toFixed(3)}, weightedVolZ=${stats.weightedVolZMean.toFixed(3)}, medianVolZ=${stats.medianVolZ.toFixed(3)}, trimmedVolZ=${stats.trimmedVolZ.toFixed(3)}, up=${stats.activeUpCount}, down=${stats.activeDownCount}, n=${stats.count}`;
    }

    private mean(values: number[]): number {
        if (values.length === 0) return 0;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    private median(values: number[]): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
        return sorted[mid];
    }

    private trimmedMean(values: number[], trimFraction: number): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const trim = Math.floor(sorted.length * trimFraction);
        const trimmed = sorted.slice(trim, sorted.length - trim);
        return this.mean(trimmed.length ? trimmed : sorted);
    }

    private resetState() {
        this.confirmedRegime = "CHOP";
        this.pendingRegime = null;
        this.pendingCount = 0;
    }
}
