import { GlobalRegime, MarketEntry } from "@/types/snapshot";

export class RegimeService {
    public infer(markets: Record<string, MarketEntry>): GlobalRegime {
        let upCount = 0;
        let downCount = 0;
        let volSum = 0;

        const marketKeys = Object.keys(markets);

        for (const key of marketKeys) {
            const m = markets[key];
            if (m.returns.m15 > 0.002) upCount++;
            if (m.returns.m15 < -0.002) downCount++;
            volSum += m.vol_zscores.vol_5m_vs_1h;
        }

        const breadth = marketKeys.length > 0 ? (upCount - downCount) / marketKeys.length : 0;
        const avgVolZ = marketKeys.length > 0 ? volSum / marketKeys.length : 0;

        let regime: GlobalRegime["current"] = "CHOP";
        let regimeReason = "Mixed signals or low volatility";

        if (avgVolZ > 1.0) {
            if (breadth > 0.3) {
                regime = "RISK_ON";
                regimeReason = "High volatility + Positive breadth";
            } else if (breadth < -0.3) {
                regime = "RISK_OFF";
                regimeReason = "High volatility + Negative breadth";
            }
        } else if (Math.abs(breadth) > 0.6) {
            regime = breadth > 0 ? "RISK_ON" : "RISK_OFF";
            regimeReason = "Low volatility but strong directional breadth";
        }

        return {
            current: regime,
            score: breadth,
            reason: regimeReason
        };
    }
}
