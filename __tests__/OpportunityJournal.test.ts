import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpportunityJournalService } from "@/services/OpportunityJournalService";
import type { MarketEntry, StateSnapshot } from "@/types/snapshot";
import type { OpportunityDiagnostic } from "@/types/trading";

const mockCreateMany = vi.hoisted(() => vi.fn());
const mockOpportunityFindFirst = vi.hoisted(() => vi.fn());
const mockSnapshotFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
    prisma: {
        opportunityJournal: {
            createMany: mockCreateMany,
            findFirst: mockOpportunityFindFirst
        },
        marketStateSnapshot: {
            findFirst: mockSnapshotFindFirst
        }
    }
}));

describe("OpportunityJournalService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCreateMany.mockResolvedValue({ count: 1 });
        mockOpportunityFindFirst.mockResolvedValue(null);
        mockSnapshotFindFirst.mockResolvedValue(null);
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
            discoveryReasons: ["HOT_MOVER", "VOLUME_SPIKE"]
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
            priceAtSignal: 1.23
        });
        expect(row.timestamp).toEqual(new Date(1777231828 * 1000));
        expect(JSON.parse(row.discoveryReasonsJson)).toEqual(["HOT_MOVER", "VOLUME_SPIKE"]);
        expect(JSON.parse(row.executionBlockReasonsJson)).toEqual(["COST_GATE"]);
        expect(JSON.parse(row.featuresJson)).toMatchObject({
            execution: { tradeable: false, costBps: 34 },
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
                execution: { tradeable: true, costBps: 5, spreadBps: 1, depthUsd: 120000 }
            }),
            executionTradeable: true,
            executionBlockReasonsJson: JSON.stringify([]),
            priceAtSignal: 50000
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
            source: "opportunity_journal"
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
