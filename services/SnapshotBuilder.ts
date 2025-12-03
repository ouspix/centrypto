import { getMetaAndAssetCtxs } from "@/lib/hyperliquid";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { StateSnapshot } from "@/types/snapshot";
import { ScreenerService } from "./ScreenerService";
import { SentimentService } from "./SentimentService";
import { MarketAnalysisService } from "./MarketAnalysisService";
import { AccountStateService } from "./AccountStateService";
import { MarketSnapshotAssembler } from "./MarketSnapshotAssembler";
import { HeldPositionMarketResolver } from "./HeldPositionMarketResolver";
import { RegimeService } from "./RegimeService";
import { MarketDerivedMetricsService } from "./MarketDerivedMetricsService";

export class SnapshotBuilder {
    private screenerServices: Record<string, ScreenerService>;
    private sentimentService: SentimentService;
    private marketAnalysisService: MarketAnalysisService;
    private accountStateService: AccountStateService;
    private marketSnapshotAssembler: MarketSnapshotAssembler;
    private heldPositionMarketResolver: HeldPositionMarketResolver;
    private regimeService: RegimeService;
    private marketDerivedMetricsService: MarketDerivedMetricsService;

    constructor() {
        this.screenerServices = {};
        this.sentimentService = new SentimentService();
        this.marketAnalysisService = new MarketAnalysisService();
        this.accountStateService = new AccountStateService();
        this.marketSnapshotAssembler = new MarketSnapshotAssembler();
        this.heldPositionMarketResolver = new HeldPositionMarketResolver(this.marketAnalysisService, this.sentimentService);
        this.regimeService = new RegimeService();
        this.marketDerivedMetricsService = new MarketDerivedMetricsService();
    }

    private getScreener(isTestnet: boolean) {
        const key = isTestnet ? "testnet" : "mainnet";
        if (!this.screenerServices[key]) {
            this.screenerServices[key] = new ScreenerService(isTestnet);
        }
        return this.screenerServices[key];
    }

    public async buildSnapshot(
        userAddress: string | null,
        isTestnet: boolean,
        config: AgentConfig = DEFAULT_AGENT_CONFIG,
        screenerConfig: ScreenerConfig = DEFAULT_SCREENER_CONFIG
    ): Promise<StateSnapshot> {
        const timestamp = Math.floor(Date.now() / 1000);
        const metaAndCtxs = await getMetaAndAssetCtxs(isTestnet);
        const assetCtxMap = new Map<string, any>();
        const assetIndexMap = new Map<string, number>();
        const networkProfile = isTestnet ? config.network_profiles.testnet : config.network_profiles.mainnet;

        if (metaAndCtxs) {
            metaAndCtxs.universe.forEach((asset: any, idx: number) => {
                assetCtxMap.set(asset.name, metaAndCtxs.assetCtxs[idx]);
                assetIndexMap.set(asset.name, idx);
            });
        }

        const { account, heldSymbols } = await this.accountStateService.buildAccountState(userAddress, isTestnet, config.risk);

        console.log("📊 Fetching Screened Market Data...");
        const screenedSymbols = await this.getScreener(isTestnet).getScreenedSymbols(isTestnet, heldSymbols, config, screenerConfig);
        console.log(`✅ Loaded ${screenedSymbols.length} symbols from screener.`);

        const { markets, duplicateMarkets } = this.marketSnapshotAssembler.buildFromScreenedSymbols(screenedSymbols, assetIndexMap);

        const { fallbackMarkets, missingMarkets } = await this.heldPositionMarketResolver.backfillPositions(
            account.current_positions,
            markets,
            assetCtxMap,
            assetIndexMap,
            isTestnet,
            screenerConfig.depthBandsPct
        );

        console.log(`📊 Total markets included in snapshot: ${Object.keys(markets).length}`);

        const global_regime = this.regimeService.infer(markets);

        this.marketDerivedMetricsService.applyDerivedMetrics(markets, config, global_regime.current, isTestnet);

        const maxNewTradesAllowed = Math.min(
            account.derived_portfolio?.slots_remaining ?? config.risk.max_new_positions_per_cycle,
            config.risk.max_new_positions_per_cycle
        );
        const effectiveMinNotional = Math.max(config.risk.min_trade_notional_usd, networkProfile.min_notional_usd);

        return {
            timestamp,
            account,
            markets,
            constraints: {
                max_position_pct_equity: config.risk.max_position_fraction,
                max_position_pct_equity_per_symbol: config.risk.max_position_fraction_per_symbol,
                max_total_exposure_pct_equity: config.risk.max_total_exposure_fraction,
                min_trade_notional_usd: effectiveMinNotional,
                kill_switch: false,
                no_flip_same_tick: config.risk.no_flip_same_tick,
                max_new_positions_per_cycle: config.risk.max_new_positions_per_cycle,
                daily_loss_kill_switch_fraction: config.risk.daily_loss_kill_switch_fraction,
                max_new_trades_allowed: maxNewTradesAllowed
            },
            allowed_actions: [
                "OPEN_POSITION",
                "INCREASE_POSITION",
                "REDUCE_POSITION",
                "CLOSE_POSITION",
                "HOLD_POSITION"
            ],
            meta: {
                note: "Generated by SnapshotBuilder with Screener",
                fallback_markets: fallbackMarkets,
                missing_markets: missingMarkets,
                duplicate_markets: duplicateMarkets
            },
            presets: {
                screening: screenerConfig,
                agent: config
            },
            global_regime
        };
    }
}

export type { StateSnapshot } from "@/types/snapshot";
