import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpportunityJournalService } from "@/services/OpportunityJournalService";
import type { MarketEntry, StateSnapshot } from "@/types/snapshot";
import type { OpportunityDiagnostic } from "@/types/trading";

const mockCreateMany = vi.hoisted(() => vi.fn());
const mockOpportunityFindFirst = vi.hoisted(() => vi.fn());
const mockOpportunityFindMany = vi.hoisted(() => vi.fn());
const mockOpportunityUpdate = vi.hoisted(() => vi.fn());
const mockSnapshotFindFirst = vi.hoisted(() => vi.fn());
const mockMarketCandleFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
    prisma: {
        opportunityJournal: {
            createMany: mockCreateMany,
            findFirst: mockOpportunityFindFirst,
            findMany: mockOpportunityFindMany,
            update: mockOpportunityUpdate
        },
        marketStateSnapshot: {
            findFirst: mockSnapshotFindFirst
        }
    }
}));

vi.mock("@/lib/market-db", () => ({
    getMarketDb: vi.fn().mockResolvedValue({
        marketCandle: {
            findMany: mockMarketCandleFindMany
        }
    }),
    withMarketDbRetry: vi.fn((_db, _label, fn) => fn())
}));

describe("OpportunityJournalService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCreateMany.mockResolvedValue({ count: 1 });
        mockOpportunityFindFirst.mockResolvedValue(null);
        mockOpportunityFindMany.mockResolvedValue([]);
        mockOpportunityUpdate.mockResolvedValue({});
        mockSnapshotFindFirst.mockResolvedValue(null);
        mockMarketCandleFindMany.mockResolvedValue([]);
    });

    it("persists execution-blocked opportunity diagnostics with market features", async () => {
        const opportunity: OpportunityDiagnostic = {
            symbol: "FARTCOIN-PERP",
            side: "long",
            inPlayScore: 72,
            setupType: "MOMENTUM_CONTINUATION",
            setupScore: 69,
            playbook: "Momentum:long",
            status: "EXECUTION_BLOCKED",
            reasons: ["IMPULSE_UP", "COST_GATE"],
            warnings: ["EXECUTION_COST_HIGH"],
            executionTradeable: false,
            executionBlockReasons: ["COST_GATE"],
            discoveryReasons: ["HOT_MOVER", "VOLUME_SPIKE"],
            structure_flags: {
                is_late_chase: true,
                is_fresh_continuation: false,
                is_pullback_continuation: false,
                is_extended_breakout: true
            },
            promotion_reason: "PRIOR_BUCKET_SHADOW:Momentum:long|long|RISK_ON|60-69|60-69|25+",
            demotion_reason: "LATE_CHASE_BLOCK",
            matched_prior_bucket: "Momentum:long|long|RISK_ON|60-69|60-69|25+",
            config_epoch: "2026-06-05T08:00:00.000Z",
            path_quality: "LATE_PATH",
            policy_outcome: "GOOD_BLOCK_UNDER_CURRENT_POLICY"
        };
        const markets = {
            "FARTCOIN-PERP": market({
                symbol: "FARTCOIN-PERP",
                price: 1.23,
                execution: {
                    tradeable: false,
                    blockReasons: ["COST_GATE"],
                    costBps: 34,
                    spreadBps: 28,
                    depthUsd: 25000
                }
            })
        };

        const result = await OpportunityJournalService.getInstance().persistSnapshotOpportunities({
            accountAddress: "0xuser",
            network: "testnet",
            snapshotId: 101,
            timestamp: 1777231828,
            opportunities: [opportunity],
            markets
        });

        expect(result.count).toBe(1);
        expect(mockCreateMany).toHaveBeenCalledTimes(1);
        const row = mockCreateMany.mock.calls[0][0].data[0];
        expect(row).toMatchObject({
            accountAddress: "0xuser",
            network: "testnet",
            snapshotId: 101,
            symbol: "FARTCOIN-PERP",
            side: "long",
            status: "EXECUTION_BLOCKED",
            inPlayScore: 72,
            setupType: "MOMENTUM_CONTINUATION",
            setupScore: 69,
            playbook: "Momentum:long",
            executionTradeable: false,
            priceAtSignal: 1.23,
            promotionReason: "PRIOR_BUCKET_SHADOW:Momentum:long|long|RISK_ON|60-69|60-69|25+",
            demotionReason: "LATE_CHASE_BLOCK",
            matchedPriorBucket: "Momentum:long|long|RISK_ON|60-69|60-69|25+",
            configEpoch: new Date("2026-06-05T08:00:00.000Z"),
            pathQuality: "LATE_PATH",
            policyOutcome: "GOOD_BLOCK_UNDER_CURRENT_POLICY"
        });
        expect(row.timestamp).toEqual(new Date(1777231828 * 1000));
        expect(JSON.parse(row.discoveryReasonsJson)).toEqual(["HOT_MOVER", "VOLUME_SPIKE"]);
        expect(JSON.parse(row.executionBlockReasonsJson)).toEqual(["COST_GATE"]);
        expect(JSON.parse(row.featuresJson)).toMatchObject({
            execution: { tradeable: false, costBps: 34 },
            structure_flags: {
                is_late_chase: true,
                is_extended_breakout: true
            },
            derived: { costs: { cost_bps: 34 } },
            market: { price: 1.23 }
        });
    });

    it("loads latest diagnostics from the opportunity journal", async () => {
        mockOpportunityFindFirst.mockResolvedValue({
            symbol: "BTC-PERP",
            side: "long",
            network: "mainnet",
            snapshotId: 77,
            timestamp: new Date("2026-06-01T08:00:00.000Z"),
            discoveryReasonsJson: JSON.stringify(["HOT_MOVER"]),
            status: "NEAR_MISS",
            inPlayScore: 63,
            setupType: "BREAKOUT_EXPANSION",
            setupScore: 68,
            playbook: "Breakout:long",
            reasonsJson: JSON.stringify(["IMPULSE_UP"]),
            warningsJson: JSON.stringify(["EXECUTION_COST_HIGH"]),
            featuresJson: JSON.stringify({
                execution: { tradeable: true, costBps: 5, spreadBps: 1, depthUsd: 120000 },
                structure_flags: {
                    is_late_chase: false,
                    is_fresh_continuation: true,
                    is_pullback_continuation: false,
                    is_extended_breakout: false
                }
            }),
            executionTradeable: true,
            executionBlockReasonsJson: JSON.stringify([]),
            priceAtSignal: 50000,
            promotionReason: "STRUCTURE_FRESH_CONTINUATION_BONUS",
            demotionReason: null,
            matchedPriorBucket: "Breakout:long|long|RISK_ON|60-69|60-69|05-10",
            configEpoch: new Date("2026-06-05T08:00:00.000Z"),
            pathQuality: "GOOD_PATH",
            policyOutcome: "MISSED_UNDER_CURRENT_POLICY"
        });

        const diagnostics = await OpportunityJournalService.getInstance().getLatestSymbolDiagnostics({
            accountAddress: "0xuser",
            network: "mainnet",
            symbol: "BTC-PERP"
        });

        expect(mockOpportunityFindFirst).toHaveBeenCalledWith({
            where: {
                network: "mainnet",
                symbol: "BTC-PERP",
                OR: [{ accountAddress: "0xuser" }, { accountAddress: null }]
            },
            orderBy: { createdAt: "desc" }
        });
        expect(diagnostics).toMatchObject({
            symbol: "BTC-PERP",
            latestSnapshotId: 77,
            discovered: true,
            discoveryReasons: ["HOT_MOVER"],
            inPlayScore: 63,
            candidateStatus: "NEAR_MISS",
            priceAtSignal: 50000,
            pathQuality: "GOOD_PATH",
            policyOutcome: "MISSED_UNDER_CURRENT_POLICY",
            promotionReason: "STRUCTURE_FRESH_CONTINUATION_BONUS",
            matchedPriorBucket: "Breakout:long|long|RISK_ON|60-69|60-69|05-10",
            configEpoch: "2026-06-05T08:00:00.000Z",
            source: "opportunity_journal"
        });
        expect(diagnostics.structureFlags).toMatchObject({
            is_fresh_continuation: true
        });
        expect(diagnostics.setupSignals[0]).toMatchObject({
            setupType: "BREAKOUT_EXPANSION",
            playbook: "Breakout:long"
        });
        expect(diagnostics.pipeline.find(stage => stage.stage === "candidate")).toMatchObject({
            status: "blocked",
            reasons: ["NEAR_MISS"]
        });
    });

    it("falls back to the latest market snapshot when no journal row exists", async () => {
        const snapshot: Partial<StateSnapshot> = {
            meta: { note: "test", snapshot_id: 55 },
            markets: {
                "ETH-PERP": market({
                    symbol: "ETH-PERP",
                    discovery: {
                        reasons: ["QUALITY_TOP"],
                        metrics: {} as any
                    },
                    execution: {
                        tradeable: false,
                        blockReasons: ["DEPTH_GATE"],
                        costBps: 4,
                        spreadBps: 1,
                        depthUsd: 5000
                    }
                })
            }
        };
        mockSnapshotFindFirst.mockResolvedValue({ id: 55, data: JSON.stringify(snapshot) });

        const diagnostics = await OpportunityJournalService.getInstance().getLatestSymbolDiagnostics({
            network: "testnet",
            symbol: "ETH-PERP"
        });

        expect(diagnostics).toMatchObject({
            symbol: "ETH-PERP",
            latestSnapshotId: 55,
            discovered: true,
            discoveryReasons: ["QUALITY_TOP"],
            source: "market_state_snapshot",
            execution: {
                tradeable: false,
                blockReasons: ["DEPTH_GATE"],
                costBps: 4
            }
        });
    });

    it("backfills forward outcomes and classifications from 1m candles", async () => {
        const timestamp = new Date("2026-06-05T08:00:00.000Z");
        mockOpportunityFindMany.mockResolvedValue([{
            id: "op-1",
            network: "testnet",
            symbol: "BTC-PERP",
            side: "long",
            status: "NEAR_MISS",
            timestamp,
            priceAtSignal: 100,
            featuresJson: JSON.stringify({
                execution: { costBps: 5 },
                structure_flags: {
                    is_late_chase: false,
                    is_fresh_continuation: true,
                    is_pullback_continuation: false,
                    is_extended_breakout: false
                }
            })
        }]);
        mockMarketCandleFindMany.mockResolvedValue(Array.from({ length: 61 }, (_, index) => ({
            openTime: new Date(timestamp.getTime() + index * 60_000),
            high: 100 + index * 0.08,
            low: 99.9,
            close: 100 + index * 0.06
        })));

        const result = await OpportunityJournalService.getInstance().updateForwardOutcomes();

        expect(result.updated).toBe(1);
        expect(mockOpportunityUpdate).toHaveBeenCalledTimes(1);
        const data = mockOpportunityUpdate.mock.calls[0][0].data;
        expect(JSON.parse(data.outcome5mJson)).toMatchObject({ horizon_minutes: 5, covered: true });
        expect(JSON.parse(data.outcome15mJson)).toMatchObject({ horizon_minutes: 15, covered: true });
        expect(JSON.parse(data.outcome1hJson)).toMatchObject({ horizon_minutes: 60, covered: true });
        expect(JSON.parse(data.outcome4hJson)).toMatchObject({ horizon_minutes: 240, covered: false });
        expect(data.pathQuality).toBe("GOOD_PATH");
        expect(data.policyOutcome).toBe("MISSED_UNDER_CURRENT_POLICY");
    });
});

function market(overrides: Partial<MarketEntry>): MarketEntry {
    return {
        symbol: "BTC-PERP",
        price: 50000,
        spread_bps: 1,
        orderbook: {
            book_pressure: 0.2,
            bid_liquidity_usd: 100000,
            ask_liquidity_usd: 100000
        },
        returns: { m5: 0.01, m15: 0.02, h1: 0.05 },
        vol_zscores: { vol_5m_vs_1h: 2, ret_5m_vs_1h: 2 },
        funding: { current_8h: 0.0001 },
        open_interest: { current: 1000000 },
        sentiment: { score: 0, mentionsVsBaseline: 1, disagreement: 0, change2h: 0 },
        derived: {
            costs: { fees_bps: 3.5, slippage_bps_est: 1, cost_bps: 34, cost_ok: false },
            edge: { expected_move_bps: 100, edge_bps: 66, edge_ok: true },
            technicals: { high_low: null, bb_width_m5: 0 },
            triggers: {
                direction_m15: 1,
                direction_h1: 1,
                trend_aligned: true,
                momentum_ok_long: true,
                momentum_ok_short: false,
                mr_ok_long: false,
                mr_ok_short: false,
                breakout_ok: true
            },
            liquidity: { min_depth_usd: 25000, depth_ok: true, tradeable: false },
            normalized: { ret_sigma_5m_vs_1h: 2, vol_ratio_5m_vs_1h: 2 },
            entry: { entry_ok: false, edge_to_cost_mult: 1.9, reasons_failed: ["COST_GATE"] },
            risk: {
                eligible: false,
                eligible_playbooks: [],
                best_anchor_key: null,
                best_anchor_value: null
            },
            rank: 1
        },
        ...overrides
    } as MarketEntry;
}
