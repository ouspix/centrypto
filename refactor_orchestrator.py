"""
Refactor OrchestratorService.ts:
1. Replace imports
2. Fix sync debug log -> async
3. Replace duplicated utility methods with shared function calls
"""
import re

with open("services/OrchestratorService.ts", "r") as f:
    content = f.read()

# 1. Replace imports
old_imports = '''import { SnapshotBuilder, StateSnapshot } from "./SnapshotBuilder";
import { MarketEntry, GlobalRegime } from "@/types/snapshot";
import { RiskCheckModule, TradeDecision, RiskAssessment } from "@/lib/risk/RiskCheckModule";
import { ExecutionEngine } from "@/lib/hyperliquidExecution";
import { placeOrder } from "@/lib/hyperliquid";
import { TradingLogger } from "@/lib/log/tradingLogger";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { prisma } from "@/lib/db";

import OpenAI from "openai";

import { TRADER_AGENT_SYSTEM_PROMPT } from "@/prompts/TraderAgent";'''

new_imports = '''import { SnapshotBuilder, StateSnapshot } from "./SnapshotBuilder";
import { MarketEntry, GlobalRegime } from "@/types/snapshot";
import { TradeDecision, RiskAssessment } from "@/types/trading";
import { RiskCheckModule } from "@/lib/risk/RiskCheckModule";
import {
    computeSizeFraction,
    clampRiskPlan,
    resolveAnchor,
    computeRiskPlan,
    computeMinConfidence,
    inferSideFromPlaybook,
    isPlaybookAllowed,
} from "@/lib/risk/shared";
import { parseLlmResponse } from "@/lib/llm/LlmResponseParser";
import { ExecutionEngine } from "@/lib/hyperliquidExecution";
import { placeOrder } from "@/lib/hyperliquid";
import { TradingLogger } from "@/lib/log/tradingLogger";
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config";
import { ScreenerConfig, DEFAULT_SCREENER_CONFIG } from "@/lib/screener-config";
import { prisma } from "@/lib/db";
import { promises as fs } from "fs";

import OpenAI from "openai";

import { TRADER_AGENT_SYSTEM_PROMPT } from "@/prompts/TraderAgent";'''

content = content.replace(old_imports, new_imports, 1)

# 2. Fix sync debug log
content = content.replace(
    "require('fs').appendFileSync('debug_llm_response.log',",
    "fs.appendFile('debug_llm_response.log',"
)
# Add .catch() after the closing backtick+);
content = content.replace(
    "-----------------------------------\\n`);\n            console.log(\"🔍 Debug: rawOutput length:\",",
    "-----------------------------------\\n`).catch(e => console.warn('⚠️ Debug log write failed:', e));\n            console.log(\"🔍 Debug: rawOutput length:\","
)

# 3. Replace duplicated utility methods with shared function delegates
# Find and replace each method

# inferSideFromPlaybook
old_infer = '''    private inferSideFromPlaybook(playbook: string): "long" | "short" | null {
        const lower = (playbook || "").toLowerCase();
        if (lower.includes("short")) return "short";
        if (lower.includes("long")) return "long";
        return null;
    }'''
new_infer = '    private inferSideFromPlaybook(playbook: string) { return inferSideFromPlaybook(playbook); }'
content = content.replace(old_infer, new_infer, 1)

# isPlaybookAllowed
old_allowed = '''    private isPlaybookAllowed(playbook: string, eligiblePlaybooks: string[]): boolean {
        if (!eligiblePlaybooks || eligiblePlaybooks.length === 0) return true;
        const normalized = (playbook || "").toLowerCase().trim();
        return eligiblePlaybooks.some(p => p.toLowerCase().trim() === normalized);
    }'''
new_allowed = '    private isPlaybookAllowed(playbook: string, eligible: string[]) { return isPlaybookAllowed(playbook, eligible); }'
content = content.replace(old_allowed, new_allowed, 1)

# computeMinConfidence
old_min_conf = '''    private computeMinConfidence(regime: string | undefined) {
        const base = 0.3;
        if (regime === "CHOP") return parseFloat((base * 1.2).toFixed(4));
        return base;
    }'''
new_min_conf = '    private computeMinConfidence(regime: string | undefined) { return computeMinConfidence(regime); }'
content = content.replace(old_min_conf, new_min_conf, 1)

# computeSizeFraction - find it between the markers
old_csf_start = '    /**\n     * Computes a size as a fraction of equity using confidence buckets, then clamps to per-trade and per-symbol caps.\n     */\n    private computeSizeFraction(confidence: number, config: AgentConfig, equity: number): number | null {'
idx = content.find(old_csf_start)
if idx >= 0:
    # find the closing brace of this method
    depth = 0
    started = False
    end_idx = idx
    for i in range(idx, len(content)):
        if content[i] == '{':
            depth += 1
            started = True
        elif content[i] == '}':
            depth -= 1
            if started and depth == 0:
                end_idx = i + 1
                break
    old_csf = content[idx:end_idx]
    new_csf = '    private computeSizeFraction(confidence: number, config: AgentConfig, equity: number) { return computeSizeFraction(confidence, config, equity); }'
    content = content.replace(old_csf, new_csf, 1)

# computeRiskPlan
old_crp_start = '    private computeRiskPlan(playbook: string, market: MarketEntry, config: AgentConfig, regime: GlobalRegime["current"], leverage: number) {'
idx = content.find(old_crp_start)
if idx >= 0:
    depth = 0
    started = False
    end_idx = idx
    for i in range(idx, len(content)):
        if content[i] == '{':
            depth += 1
            started = True
        elif content[i] == '}':
            depth -= 1
            if started and depth == 0:
                end_idx = i + 1
                break
    old_crp = content[idx:end_idx]
    new_crp = '    private computeRiskPlan(playbook: string, market: MarketEntry | any, config: AgentConfig, regime: GlobalRegime["current"], leverage: number) {\n        return computeRiskPlan(playbook, market, config, regime, leverage);\n    }'
    content = content.replace(old_crp, new_crp, 1)

# resolveAnchor
old_ra_start = '    private resolveAnchor(market: MarketEntry, config: AgentConfig): { key: string | null, value: number | null } {'
idx = content.find(old_ra_start)
if idx >= 0:
    depth = 0
    started = False
    end_idx = idx
    for i in range(idx, len(content)):
        if content[i] == '{':
            depth += 1
            started = True
        elif content[i] == '}':
            depth -= 1
            if started and depth == 0:
                end_idx = i + 1
                break
    old_ra = content[idx:end_idx]
    new_ra = '    private resolveAnchor(market: MarketEntry | any, config: AgentConfig) { return resolveAnchor(market, config); }'
    content = content.replace(old_ra, new_ra, 1)

# getValueByPath
old_gvp_start = '    private getValueByPath(obj: any, path: string): number | null {'
idx = content.find(old_gvp_start)
if idx >= 0:
    depth = 0
    started = False
    end_idx = idx
    for i in range(idx, len(content)):
        if content[i] == '{':
            depth += 1
            started = True
        elif content[i] == '}':
            depth -= 1
            if started and depth == 0:
                end_idx = i + 1
                break
    old_gvp = content[idx:end_idx]
    content = content.replace(old_gvp, '', 1)

# clampDecisionRiskPlan
old_cdrp = '''    /**
     * Clamp stop loss to the allowed bounds before sending to risk manager.
     */
    private clampDecisionRiskPlan(decision: TradeDecision) {
        if (!decision.risk_plan) return;
        const minSl = 0.005; // 0.5% of equity
        const maxSl = 0.05;  // 5% of equity
        const minTp = 0.01;  // 1% target floor to avoid tiny profits
        const minRr = 1.5;

        const sl = decision.risk_plan.stop_loss_pct;
        if (sl === undefined || sl === null) return;
        const clampedSl = Math.min(maxSl, Math.max(minSl, Math.abs(sl)));
        decision.risk_plan.stop_loss_pct = clampedSl;

        const tp = decision.risk_plan.take_profit_pct_primary;
        const floorTp = Math.max(minTp, minRr * clampedSl);
        if (tp === undefined || tp === null || tp < floorTp) {
            decision.risk_plan.take_profit_pct_primary = floorTp;
        }
    }'''
new_cdrp = '    private clampDecisionRiskPlan(decision: TradeDecision) { clampRiskPlan(decision); }'
content = content.replace(old_cdrp, new_cdrp, 1)

with open("services/OrchestratorService.ts", "w") as f:
    f.write(content)

print("Done. File refactored successfully.")
