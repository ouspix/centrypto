import { NextResponse } from "next/server";
import { AGENT_PRESETS } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { BacktestRunner } from "@/src/backtest/BacktestRunner";
import { BacktestPolicyName } from "@/src/backtest/BacktestTypes";

type BacktestRequestBody = {
    start?: string;
    end?: string;
    initialCapital?: number;
    capital?: number;
    network?: "mainnet" | "testnet";
    intervalSeconds?: number;
    screeningPresetName?: string;
    agentPresetName?: string;
    policyName?: BacktestPolicyName;
    managementPolicyName?: "never_close" | "playbook_aware";
    seed?: number;
    featureDbPath?: string;
    runId?: string;
};

export async function POST(request: Request) {
    try {
        const body = await request.json() as BacktestRequestBody;
        const start = parseDate(body.start, "start");
        const end = parseDate(body.end, "end");
        if (end <= start) {
            return NextResponse.json({ error: "end must be after start" }, { status: 400 });
        }

        const agentPresetName = body.agentPresetName ?? "Momentum Moderate";
        const screeningPresetName = body.screeningPresetName ?? "Momentum Moderate";
        const agentConfig = AGENT_PRESETS[agentPresetName];
        const screeningConfig = SCREENER_PRESETS[screeningPresetName];
        if (!agentConfig) {
            return NextResponse.json({ error: `Unknown agent preset: ${agentPresetName}` }, { status: 400 });
        }
        if (!screeningConfig) {
            return NextResponse.json({ error: `Unknown screening preset: ${screeningPresetName}` }, { status: 400 });
        }

        const result = await new BacktestRunner().run({
            network: body.network ?? "mainnet",
            start,
            end,
            intervalSeconds: body.intervalSeconds ?? 10,
            initialCapitalUsd: body.initialCapital ?? body.capital ?? 10000,
            screeningPresetName,
            agentPresetName,
            screeningConfig,
            agentConfig,
            policyName: body.policyName ?? "take_top_rank",
            managementPolicyName: body.managementPolicyName ?? "playbook_aware",
            seed: body.seed ?? 1,
            featureDbPath: body.featureDbPath,
            runId: body.runId
        });

        return NextResponse.json({
            run_id: result.run_id,
            metrics: result.metrics,
            coverage: result.coverage,
            trades: result.trades,
            equity_curve: result.equity_curve.map(point => ({
                ts: point.ts.toISOString(),
                equity_usd: point.equity_usd
            }))
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /start is required|end is required|Invalid .* date/.test(message) ? 400 : 500;
        console.error("Backtest API Error:", error);
        return NextResponse.json({ error: message }, { status });
    }
}

function parseDate(value: string | undefined, name: string): Date {
    if (!value) throw new Error(`${name} is required`);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${name} date`);
    return date;
}
