import { NextResponse } from "next/server";
import { AGENT_PRESETS } from "@/lib/agent-config";
import { SCREENER_PRESETS } from "@/lib/screener-config";
import { BacktestRunner } from "@/src/backtest/BacktestRunner";
import { BacktestDecisionMode, BacktestLlmConfig, BacktestPolicyName } from "@/src/backtest/BacktestTypes";
import { InternalAuthError, requireInternalRequest } from "@/lib/auth/internal";

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
    decisionMode?: BacktestDecisionMode;
    managementPolicyName?: "never_close" | "playbook_aware";
    seed?: number;
    featureDbPath?: string;
    runId?: string;
    llm?: BacktestLlmConfig;
    llmEnabled?: boolean;
    llmModel?: string;
    llmDecisions?: string;
    llmTrace?: string;
    ollamaBaseUrl?: string;
};

export async function POST(request: Request) {
    try {
        requireInternalRequest(request);
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
        const decisionMode = body.decisionMode ?? decisionModeFromPolicy(body.policyName);

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
            policyName: body.policyName ?? "main_app_deterministic",
            decisionMode,
            managementPolicyName: body.managementPolicyName ?? "never_close",
            seed: body.seed ?? 1,
            featureDbPath: body.featureDbPath,
            runId: body.runId,
            llm: buildLlmConfig(body, decisionMode)
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
        if (error instanceof InternalAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        const message = error instanceof Error ? error.message : String(error);
        const status = /start is required|end is required|Invalid .* date/.test(message) ? 400 : 500;
        console.error("Backtest API Error:", error);
        return NextResponse.json({ error: message }, { status });
    }
}

function decisionModeFromPolicy(policyName: BacktestPolicyName | undefined): BacktestDecisionMode {
    if (policyName === "recorded_llm" || policyName === "real_llm") return policyName;
    return "deterministic";
}

function buildLlmConfig(body: BacktestRequestBody, decisionMode: BacktestDecisionMode): BacktestLlmConfig | undefined {
    if (decisionMode !== "real_llm" && decisionMode !== "recorded_llm") return undefined;
    if (body.llm) return body.llm;
    if (!body.llmEnabled) throw new Error(`${decisionMode} requires llmEnabled`);
    if (decisionMode === "recorded_llm" && !body.llmDecisions) throw new Error("recorded_llm requires llmDecisions");
    return {
        enabled: true,
        model: body.llmModel ?? "llama3.1",
        decisionsPath: body.llmDecisions,
        tracePath: body.llmTrace,
        ollamaBaseUrl: body.ollamaBaseUrl
    };
}

function parseDate(value: string | undefined, name: string): Date {
    if (!value) throw new Error(`${name} is required`);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${name} date`);
    return date;
}
