import fs from "fs/promises";
import { EligibleCandidate, TraderContext, TraderDecision } from "@/types/trading";
import { parseTraderResponse } from "@/lib/llm/LlmResponseParser";
import { TRADER_AGENT_SYSTEM_PROMPT } from "@/prompts/TraderAgent";
import { BacktestLlmConfig, PositionManagementPolicy, SimPosition, TraderPolicy } from "./BacktestTypes";

export class TakeNoneTrader implements TraderPolicy {
    constructor(private readonly managementPolicy: PositionManagementPolicy = new NeverClosePolicy()) {}

    public async decide(ctx: TraderContext): Promise<TraderDecision[]> {
        return manageExisting(ctx, this.managementPolicy, new Map());
    }
}

export class TakeTopRankTrader implements TraderPolicy {
    constructor(
        private readonly managementPolicy: PositionManagementPolicy = new NeverClosePolicy(),
        private readonly positions: Map<string, SimPosition> = new Map()
    ) {}

    public async decide(ctx: TraderContext): Promise<TraderDecision[]> {
        const decisions = manageExisting(ctx, this.managementPolicy, this.positions);
        const candidate = [...ctx.eligible_candidates].sort(byRank)[0];
        if (candidate) decisions.push(openDecision(candidate, "take_top_rank"));
        return decisions;
    }
}

export class TakeBestEdgeCostTrader implements TraderPolicy {
    constructor(
        private readonly managementPolicy: PositionManagementPolicy = new NeverClosePolicy(),
        private readonly positions: Map<string, SimPosition> = new Map()
    ) {}

    public async decide(ctx: TraderContext): Promise<TraderDecision[]> {
        const decisions = manageExisting(ctx, this.managementPolicy, this.positions);
        const candidate = [...ctx.eligible_candidates].sort((a, b) =>
            (b.market_quality.edge_to_cost_mult - a.market_quality.edge_to_cost_mult) ||
            (a.risk.cost_to_stop_ratio - b.risk.cost_to_stop_ratio) ||
            byRank(a, b)
        )[0];
        if (candidate) decisions.push(openDecision(candidate, "take_best_edge_cost"));
        return decisions;
    }
}

export class CleanOnlyTrader implements TraderPolicy {
    constructor(
        private readonly managementPolicy: PositionManagementPolicy = new NeverClosePolicy(),
        private readonly positions: Map<string, SimPosition> = new Map()
    ) {}

    public async decide(ctx: TraderContext): Promise<TraderDecision[]> {
        const decisions = manageExisting(ctx, this.managementPolicy, this.positions);
        const candidate = [...ctx.eligible_candidates]
            .filter(candidate =>
                candidate.market_quality.edge_to_cost_mult >= 8 &&
                candidate.risk.cost_to_stop_ratio <= 0.5 &&
                candidate.risk.cost_to_tp_ratio <= 0.3 &&
                !candidate.warnings.some(warning => /severe|kill|halt|blocked/i.test(warning))
            )
            .sort(byRank)[0];
        if (candidate) decisions.push(openDecision(candidate, "clean_only"));
        return decisions;
    }
}

export class RecordedLLMTrader implements TraderPolicy {
    private loaded = false;
    private readonly decisionsByTimestamp = new Map<number, TraderDecision[]>();

    constructor(
        private readonly config: BacktestLlmConfig,
        private readonly managementPolicy: PositionManagementPolicy = new NeverClosePolicy(),
        private readonly positions: Map<string, SimPosition> = new Map()
    ) {}

    public async decide(ctx: TraderContext): Promise<TraderDecision[]> {
        await this.load();
        const recorded = this.decisionsByTimestamp.get(ctx.timestamp) ?? [];
        if (recorded.length > 0) return recorded;
        return manageExisting(ctx, this.managementPolicy, this.positions);
    }

    private async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        if (!this.config.decisionsPath) throw new Error("recorded_llm policy requires llm.decisionsPath");
        const content = await fs.readFile(this.config.decisionsPath, "utf8");
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const record = JSON.parse(line) as { timestamp?: number; ts?: string; decisions?: TraderDecision[] };
            const timestamp = typeof record.timestamp === "number"
                ? record.timestamp
                : record.ts
                    ? Math.floor(new Date(record.ts).getTime() / 1000)
                    : null;
            if (timestamp === null || !Array.isArray(record.decisions)) continue;
            this.decisionsByTimestamp.set(timestamp, record.decisions.map(normalizeTraderDecision));
        }
    }
}

export class RealLLMTrader implements TraderPolicy {
    constructor(private readonly config: BacktestLlmConfig) {}

    public async decide(ctx: TraderContext): Promise<TraderDecision[]> {
        if (!this.config.enabled) return [];
        const prompt = buildTraderPrompt(ctx);
        const rawOutput = await callTraderLlm(prompt, this.config);
        let decisions: TraderDecision[] = [];
        let parseError: string | null = null;
        try {
            decisions = parseTraderResponse(rawOutput).map(normalizeTraderDecision);
        } catch (error) {
            parseError = error instanceof Error ? error.message : String(error);
        }

        if (this.config.tracePath) {
            await appendJsonl(this.config.tracePath, {
                ts: new Date(ctx.timestamp * 1000).toISOString(),
                timestamp: ctx.timestamp,
                snapshot_id: ctx.snapshot_id,
                model: this.config.model,
                prompt,
                response: rawOutput,
                decisions,
                parse_error: parseError
            });
        }

        return decisions;
    }
}

export class NeverClosePolicy implements PositionManagementPolicy {
    public decide(position: SimPosition, ctx: TraderContext): TraderDecision {
        return {
            scope: "position",
            action: "HOLD_POSITION",
            candidate_id: null,
            symbol: position.symbol,
            target_side: position.side,
            target_size_fraction_of_equity: position.size_fraction,
            playbook: position.playbook,
            confidence: 0.5,
            reason_code: "position_management",
            notes: `${ctx.global_regime}: never_close baseline`
        };
    }
}

export class PlaybookAwarePolicy implements PositionManagementPolicy {
    public decide(position: SimPosition, ctx: TraderContext): TraderDecision {
        const managed = ctx.existing_positions.find(p => p.symbol === position.symbol);
        const pressure = managed?.market_signal.book_pressure ?? null;
        const ageMinutes = Math.max(0, (ctx.timestamp * 1000 - position.entry_ts.getTime()) / 60_000);
        const profitable = (position.unrealized_pnl_usd ?? 0) > 0;
        const playbook = position.playbook.toLowerCase();

        let close = false;
        let reason = "hold_thesis_intact";

        if (playbook.includes("momentum")) {
            const opposite = isOppositePressure(position.side, pressure, 0.08);
            position.opposite_pressure_cycles = opposite ? (position.opposite_pressure_cycles ?? 0) + 1 : 0;
            close = managed?.market_signal.regime_conflict === true ||
                (position.opposite_pressure_cycles >= 3) ||
                (ageMinutes >= 180 && !profitable);
            reason = close ? "momentum_thesis_break" : reason;
        } else if (playbook.includes("breakout")) {
            close = (ageMinutes >= 90 && !profitable) || isOppositePressure(position.side, pressure, 0.08);
            reason = close ? "breakout_no_follow_through" : reason;
        } else if (playbook.includes("mean reversion")) {
            const currentSigma = managed?.market_signal.ret_sigma_5m_vs_1h;
            const entrySigma = position.entry_signal.ret_sigma_5m_vs_1h;
            const worsened = currentSigma !== null && currentSigma !== undefined && entrySigma !== null &&
                Math.abs(currentSigma) >= Math.abs(entrySigma) + 1.0;
            close = worsened || (ageMinutes >= 45 && !profitable) || isOppositePressure(position.side, pressure, 0.05);
            reason = close ? "mean_reversion_failed_snapback" : reason;
        } else {
            close = (ageMinutes >= 30 && !profitable) || isOppositePressure(position.side, pressure, 0.03);
            reason = close ? "scout_deterioration" : reason;
        }

        if (!close) return new NeverClosePolicy().decide(position, ctx);
        return {
            scope: "position",
            action: "CLOSE_POSITION",
            candidate_id: null,
            symbol: position.symbol,
            target_side: "flat",
            target_size_fraction_of_equity: 0,
            playbook: position.playbook,
            confidence: 0.65,
            reason_code: "position_management",
            notes: reason
        };
    }
}

export function buildTraderPolicy(
    name: string,
    managementPolicy: PositionManagementPolicy,
    positions: Map<string, SimPosition>,
    llmConfig?: BacktestLlmConfig
): TraderPolicy {
    if (name === "take_none") return new TakeNoneTrader(managementPolicy);
    if (name === "take_best_edge_cost") return new TakeBestEdgeCostTrader(managementPolicy, positions);
    if (name === "clean_only") return new CleanOnlyTrader(managementPolicy, positions);
    if (name === "recorded_llm") {
        if (!llmConfig?.enabled) throw new Error("recorded_llm policy requires llm.enabled");
        return new RecordedLLMTrader(llmConfig, managementPolicy, positions);
    }
    if (name === "real_llm") {
        if (!llmConfig?.enabled) throw new Error("real_llm policy requires explicit llm.enabled");
        return new RealLLMTrader(llmConfig);
    }
    return new TakeTopRankTrader(managementPolicy, positions);
}

export function buildManagementPolicy(name: string): PositionManagementPolicy {
    return name === "playbook_aware" ? new PlaybookAwarePolicy() : new NeverClosePolicy();
}

function manageExisting(
    ctx: TraderContext,
    policy: PositionManagementPolicy,
    positions: Map<string, SimPosition>
): TraderDecision[] {
    const decisions: TraderDecision[] = [];
    for (const managed of ctx.existing_positions) {
        const sim = positions.get(managed.symbol) ?? {
            id: managed.symbol,
            symbol: managed.symbol,
            side: managed.side,
            playbook: "none",
            entry_ts: new Date(ctx.timestamp * 1000),
            entry_price: managed.entry_price,
            size_fraction: managed.exposure_fraction,
            notional_usd: managed.size_usd,
            size_coin: managed.entry_price > 0 ? managed.size_usd / managed.entry_price : 0,
            stop_loss_pct: 0.02,
            take_profit_pct: 0.04,
            entry_regime: ctx.global_regime,
            entry_signal: {
                ret_sigma_5m_vs_1h: managed.market_signal.ret_sigma_5m_vs_1h,
                vol_ratio_5m_vs_1h: managed.market_signal.vol_ratio_5m_vs_1h,
                book_pressure: managed.market_signal.book_pressure,
                trend_alignment_score: managed.market_signal.trend_aligned ? 1 : 0,
                edge_to_cost_mult: null
            },
            highest_price: managed.entry_price,
            lowest_price: managed.entry_price,
            max_favorable_excursion_bps: 0,
            max_adverse_excursion_bps: 0
        };
        decisions.push(policy.decide(sim, ctx));
    }
    return decisions;
}

function openDecision(candidate: EligibleCandidate, notes: string): TraderDecision {
    return {
        scope: "candidate",
        action: "OPEN_POSITION",
        candidate_id: candidate.candidate_id,
        symbol: candidate.symbol,
        target_side: candidate.side,
        target_size_fraction_of_equity: candidate.sizing.suggested_size_fraction,
        playbook: candidate.eligible_playbooks[0],
        confidence: 0.7,
        reason_code: candidate.eligible_playbooks[0].startsWith("Momentum")
            ? "momentum_edge"
            : candidate.eligible_playbooks[0].startsWith("Breakout")
                ? "breakout_edge"
                : "mean_reversion_edge",
        notes
    };
}

function byRank(a: EligibleCandidate, b: EligibleCandidate): number {
    return (a.market_quality.rank ?? Number.POSITIVE_INFINITY) - (b.market_quality.rank ?? Number.POSITIVE_INFINITY);
}

function isOppositePressure(side: "long" | "short", pressure: number | null, threshold: number): boolean {
    if (pressure === null || !Number.isFinite(pressure)) return false;
    return side === "long" ? pressure <= -threshold : pressure >= threshold;
}

function normalizeTraderDecision(decision: TraderDecision): TraderDecision {
    return {
        scope: decision.scope,
        action: decision.action,
        candidate_id: decision.candidate_id ?? null,
        symbol: decision.symbol,
        target_side: decision.target_side,
        target_size_fraction_of_equity: decision.target_size_fraction_of_equity,
        playbook: decision.playbook ?? null,
        confidence: decision.confidence,
        reason_code: decision.reason_code,
        notes: decision.notes
    };
}

function buildTraderPrompt(ctx: TraderContext): string {
    return [
        "Historical replay context. Use only this timestamp-bounded context.",
        JSON.stringify(ctx, null, 2)
    ].join("\n");
}

async function callTraderLlm(prompt: string, config: BacktestLlmConfig): Promise<string> {
    if (shouldUseOpenRouter(config.model)) {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key) throw new Error("OPENROUTER_API_KEY is required for this LLM model");
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${key}`,
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "Centrypto Backtest"
            },
            body: JSON.stringify({
                model: config.model,
                messages: [
                    { role: "system", content: TRADER_AGENT_SYSTEM_PROMPT },
                    { role: "user", content: prompt }
                ],
                temperature: 0.3,
                top_p: 0.9,
                max_tokens: 8000
            })
        });
        if (!res.ok) throw new Error(`OpenRouter LLM call failed: ${res.status} ${await res.text()}`);
        const json = await res.json();
        return json?.choices?.[0]?.message?.content ?? JSON.stringify(json);
    }

    const baseUrl = config.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const res = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: config.model,
            system: TRADER_AGENT_SYSTEM_PROMPT,
            prompt,
            stream: false,
            options: { temperature: 0.3, top_p: 0.9, num_ctx: 15000 }
        })
    });
    if (!res.ok) throw new Error(`Ollama LLM call failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return typeof json?.response === "string" ? json.response : JSON.stringify(json);
}

function shouldUseOpenRouter(model: string): boolean {
    return model.includes("/") || model.startsWith("gpt") || model.startsWith("anthropic");
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
    await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}
