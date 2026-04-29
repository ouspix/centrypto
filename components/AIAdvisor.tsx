"use client"

import { useState, useEffect, useRef } from "react"
import { useAccount } from "wagmi"
import { placeOrderAction } from "@/app/actions/trade"
import { getMeta } from "@/lib/hyperliquid"
import { getCloseOrderParams } from "@/lib/trade-utils"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import { BrainCircuit, Play, Pause, AlertOctagon, Loader2, Activity, ShieldAlert, Settings, Info, Ban } from "lucide-react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useTrading } from "@/context/TradingContext"
import { ConfigEditor } from "@/components/ui/ConfigEditor"
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config"
import { LlmRunStatus, TradeDecision, RiskAssessment } from "@/types/trading"

type AnalysisResult = {
    decisions: TradeDecision[];
    riskAssessments: RiskAssessment[];
    snapshot: any;
    prompt: string;
    rawOutput: string;
    llmStatus?: LlmRunStatus;
};

export function AIAdvisor() {
    const { isTestnet } = useTrading()
    const { address } = useAccount()
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<AnalysisResult | null>(null)
    const [executing, setExecuting] = useState<number | null>(null)
    const [currentJobId, setCurrentJobId] = useState<string | null>(null)
    const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

    const executeDecision = async (decision: TradeDecision, index: number) => {
        if (!result || !result.snapshot) return;
        setExecuting(index);

        try {
            // If risk check flagged it, ask for manual override confirmation (manual only)
            const risk = result.riskAssessments?.[index];
            if (risk && risk.approved === false) {
                const proceed = window.confirm(`Risk check did NOT approve this trade (${risk.reason}). Execute anyway?`);
                if (!proceed) {
                    setExecuting(null);
                    return;
                }
            }

            const market = result.snapshot.markets[decision.symbol!];
            if (!market) throw new Error(`Market data not found for ${decision.symbol}`);

            const price = market.price;
            const equity = result.snapshot.account.equity_usd;

            // Get asset index
            const universe = await getMeta(isTestnet);
            const assetInfo = universe.find((a: any) => a.name === decision.symbol?.split("-")[0]);
            if (!assetInfo) throw new Error(`Asset info not found for ${decision.symbol}`);

            const assetIndex = universe.indexOf(assetInfo);

            let orderRequest;

            if (decision.action === "OPEN_POSITION" || decision.action === "INCREASE_POSITION") {
                const sizeFraction = Number(decision.target_size_fraction_of_equity) || 0;
                const equityNum = Number(equity);

                console.log(`🧮 Sizing Calc: Equity=${equityNum}, Fraction=${sizeFraction}, Price=${price}`);

                if (isNaN(equityNum) || equityNum <= 0) {
                    throw new Error(`Invalid equity value: ${equity}`);
                }

                const sizeUsd = equityNum * sizeFraction;
                let size = sizeUsd / price;

                if (decision.action === "INCREASE_POSITION") {
                    // Find current position
                    const position = result.snapshot.account.current_positions.find((p: any) => p.symbol === decision.symbol);
                    if (position) {
                        const currentSizeUsd = Number(position.size_usd);
                        const increaseAmountUsd = sizeUsd - currentSizeUsd;

                        if (increaseAmountUsd <= 0) {
                            toast.info(`Position already at or above target size. Current: $${currentSizeUsd.toFixed(0)}, Target: $${sizeUsd.toFixed(0)}`);
                            setExecuting(null);
                            return;
                        }

                        size = increaseAmountUsd / price;
                        console.log(`📈 Increasing position by $${increaseAmountUsd.toFixed(2)} (${size.toFixed(4)} coins) to reach target $${sizeUsd.toFixed(2)}`);
                    }
                }

                if (isNaN(size) || size <= 0) {
                    throw new Error(`Invalid calculated size: ${size} (Target USD: ${sizeUsd}, Price: ${price})`);
                }

                const isBuy = decision.target_side === "long";

                // Aggressive limit price (5% buffer) to ensure fill
                const limitPx = isBuy ? price * 1.05 : price * 0.95;

                let stopLossPrice: number | undefined;
                let takeProfitPrice: number | undefined;

                if (decision.risk_plan) {
                    const slPct = Math.abs(decision.risk_plan.stop_loss_pct);
                    const tpPct = Math.abs(decision.risk_plan.take_profit_pct_primary);
                    stopLossPrice = isBuy ? price * (1 - slPct) : price * (1 + slPct);
                    takeProfitPrice = isBuy ? price * (1 + tpPct) : price * (1 - tpPct);
                }

                orderRequest = {
                    asset: assetIndex,
                    isBuy,
                    limitPx,
                    sz: size,
                    reduceOnly: false,
                    stopLossPrice,
                    takeProfitPrice
                };
            } else if (decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION") {
                // Find current position size
                const position = result.snapshot.account.current_positions.find((p: any) => p.symbol === decision.symbol);
                if (!position) throw new Error("No open position to close");

                // Use the exact coin size from the snapshot if available, otherwise fallback (though snapshot should have it now)
                let sizeToClose = position.size_coin !== undefined
                    ? position.size_coin
                    : Math.abs(Number(position.size_usd) / price); // Fallback estimate

                if (decision.action === "REDUCE_POSITION") {
                    const targetFraction = Number(decision.target_size_fraction_of_equity) || 0;
                    const targetSizeUsd = Number(equity) * targetFraction;
                    const currentSizeUsd = Number(position.size_usd);

                    const reduceAmountUsd = currentSizeUsd - targetSizeUsd;

                    if (reduceAmountUsd <= 0) {
                        toast.info(`Position already below target size. Current: $${currentSizeUsd.toFixed(0)}, Target: $${targetSizeUsd.toFixed(0)}`);
                        setExecuting(null);
                        return;
                    }

                    // Convert USD reduction to Coin size
                    sizeToClose = reduceAmountUsd / price;
                    console.log(`📉 Reducing position by $${reduceAmountUsd.toFixed(2)} (${sizeToClose.toFixed(4)} coins) to reach target $${targetSizeUsd.toFixed(2)}`);
                }

                const isLong = position.side === "long";

                orderRequest = getCloseOrderParams(assetIndex, sizeToClose, price, isLong);
            } else {
                toast.info("Action not executable");
                setExecuting(null);
                return;
            }

            console.log("🚀 Executing order:", orderRequest);
            const res = await placeOrderAction(orderRequest, isTestnet);

            if (res.success) {
                toast.success(`Order executed: ${decision.action}`);
            } else {
                toast.error(`Execution failed: ${res.error}`);
            }

        } catch (error: any) {
            console.error("Execution error:", error);
            toast.error(`Error: ${error.message}`);
        } finally {
            setExecuting(null);
        }
    }

    // Controls
    const [autoTrading, setAutoTrading] = useState(false)
    const [isInitialized, setIsInitialized] = useState(false)

    const DEFAULT_TRADING_INTERVAL = 600; // 10 minutes
    const [frequency, setFrequency] = useState(DEFAULT_TRADING_INTERVAL) // seconds
    const [selectedModel, setSelectedModel] = useState("deepseek/deepseek-v3.2-exp")
    const [availableModels, setAvailableModels] = useState<string[]>([])
    const [killSwitch, setKillSwitch] = useState(false)
    const [showConfig, setShowConfig] = useState(false)
    const [customConfig, setCustomConfig] = useState<AgentConfig | undefined>(undefined)
    const [agentPreset, setAgentPreset] = useState<string>('default')

    // Load Auto Trading State & Settings
    useEffect(() => {
        const savedAuto = localStorage.getItem('autoTrading');
        if (savedAuto) {
            setAutoTrading(savedAuto === 'true');
        }

        const savedFreq = localStorage.getItem('aiAdvisor_frequency');
        if (savedFreq) {
            setFrequency(Number(savedFreq));
        }

        const savedModel = localStorage.getItem('aiAdvisor_selectedModel');
        if (savedModel) {
            setSelectedModel(savedModel);
        }

        setIsInitialized(true);
    }, []);

    // Save Auto Trading State & Settings
    useEffect(() => {
        if (isInitialized) {
            localStorage.setItem('autoTrading', String(autoTrading));
            localStorage.setItem('aiAdvisor_frequency', String(frequency));
            localStorage.setItem('aiAdvisor_selectedModel', selectedModel);
        }
    }, [autoTrading, frequency, selectedModel, isInitialized]);

    const timerRef = useRef<NodeJS.Timeout | null>(null)
    const abortControllerRef = useRef<AbortController | null>(null)

    // Poll Job Status
    const pollJobStatus = async (jobId: string) => {
        try {
            const res = await fetch(`/api/ai/job-status?jobId=${jobId}`);
            if (!res.ok) {
                if (res.status === 404) {
                    // Job lost?
                    console.error("Job not found, stopping poll");
                    stopPolling();
                    setLoading(false);
                    setCurrentJobId(null);
                    localStorage.removeItem('currentAnalysisJobId');
                }
                return;
            }

            const job = await res.json();

            if (job.status === 'completed') {
                console.log("✅ Analysis job completed");
                setResult({ ...job.result, riskAssessments: job.result?.riskAssessments || [] });
                setLoading(false);
                stopPolling();
                setCurrentJobId(null);
                localStorage.removeItem('currentAnalysisJobId');
            } else if (job.status === 'failed' || job.status === 'cancelled') {
                console.error("❌ Analysis job failed/cancelled:", job.error);
                setLoading(false);
                stopPolling();
                setCurrentJobId(null);
                localStorage.removeItem('currentAnalysisJobId');
                if (job.status === 'failed') {
                    toast.error(`Analysis failed: ${job.error}`);
                }
            } else {
                // Still running/pending, continue polling
                console.log(`⏳ Job ${jobId} status: ${job.status}`);
            }
        } catch (e) {
            console.error("Polling error", e);
        }
    }

    const startPolling = (jobId: string) => {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        setCurrentJobId(jobId);
        localStorage.setItem('currentAnalysisJobId', jobId);
        pollIntervalRef.current = setInterval(() => pollJobStatus(jobId), 2000);
    }

    const stopPolling = () => {
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }
    }

    // Resume polling on mount
    useEffect(() => {
        const savedJobId = localStorage.getItem('currentAnalysisJobId');
        if (savedJobId) {
            console.log("🔄 Resuming analysis job:", savedJobId);
            setLoading(true);
            startPolling(savedJobId);
        }
        return () => stopPolling();
    }, []);

    // Load Config
    useEffect(() => {
        const saved = localStorage.getItem('agentConfig');
        if (saved) {
            try {
                setCustomConfig(JSON.parse(saved));
            } catch (e) {
                console.error("Failed to parse saved config", e);
            }
        }
        const savedPreset = localStorage.getItem('agentPreset');
        if (savedPreset) {
            setAgentPreset(savedPreset);
        }
    }, [])

    const handleSaveConfig = (newConfig: AgentConfig, newPreset: string) => {
        setCustomConfig(newConfig);
        localStorage.setItem('agentConfig', JSON.stringify(newConfig));
        setAgentPreset(newPreset);
        localStorage.setItem('agentPreset', newPreset);
        setShowConfig(false);
    }

    // Fetch Models
    useEffect(() => {
        fetch('/api/ai/models')
            .then(res => res.json())
            .then(data => {
                if (data.models) {
                    setAvailableModels(data.models.map((m: any) => m.name));
                }
            })
            .catch(err => console.error("Failed to fetch models", err));
    }, [])

    const analyzeMarket = async () => {
        if (killSwitch) return;

        setLoading(true)

        // Create new AbortController for this request (only for auto-trading or legacy fallback)
        abortControllerRef.current = new AbortController();

        try {
            // Read screening config from localStorage
            let screeningConfig = null;
            try {
                const saved = localStorage.getItem('screeningConfig');
                if (saved) {
                    screeningConfig = JSON.parse(saved);
                    console.log('📋 Screening config from localStorage:', screeningConfig);
                } else {
                    console.log('📋 No screening config in localStorage');
                }
            } catch (e) {
                console.error('Failed to read screening config', e);
            }

            const body = {
                userAddress: address || null,
                autoTrading: autoTrading,
                screeningConfig,
                configOverride: customConfig,
                isManual: !autoTrading, // Flag for manual analysis
                isTestnet: isTestnet,
                model: selectedModel
            };

            const response = await fetch('/api/ai/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: abortControllerRef.current.signal
            })

            if (!response.ok) {
                throw new Error('Analysis failed')
            }

            const data = await response.json()

            if (!autoTrading && data.jobId) {
                // Manual analysis started with job tracking
                console.log("🚀 Started manual analysis job:", data.jobId);
                startPolling(data.jobId);
            } else {
                // Auto-trading (synchronous)
                setResult({ ...data, riskAssessments: data.riskAssessments || [] })
                setLoading(false)
            }

        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                console.log("Analysis cancelled by user")
            } else {
                console.error("Analysis failed", error)
                setLoading(false)
            }
        } finally {
            // Only clear loading if NOT using job tracking (auto-trading or error)
            // For manual job, polling handles loading state
            if (autoTrading) {
                abortControllerRef.current = null;
            }
        }
    }

    const cancelAnalysis = async () => {
        // 1. Cancel client-side abort controller (if any)
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }

        // 2. Cancel Job if active
        if (currentJobId) {
            try {
                await fetch('/api/ai/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId: currentJobId })
                });
                console.log('✅ Job cancellation requested');
            } catch (error) {
                console.error('Failed to cancel job:', error);
            }
            stopPolling();
            setCurrentJobId(null);
            localStorage.removeItem('currentAnalysisJobId');
        } else {
            // Legacy/Auto-trading cancel
            try {
                await fetch('/api/ai/cancel', { method: 'POST' });
                console.log('✅ Backend cancellation requested');
            } catch (error) {
                console.error('Failed to cancel backend request:', error);
            }
        }

        setLoading(false);
    }

    // Auto Trading Loop
    useEffect(() => {
        if (autoTrading && !killSwitch) {
            // Initial call
            analyzeMarket();

            // Interval
            timerRef.current = setInterval(analyzeMarket, frequency * 1000);
        } else {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        }

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        }
    }, [autoTrading, frequency, killSwitch, selectedModel, address, isTestnet])

    const handleKillSwitch = () => {
        setKillSwitch(true);
        setAutoTrading(false);
        // Ideally call backend to cancel all orders here
        console.log("KILL SWITCH ACTIVATED");
    }

    const formatDiagnosticLabel = (value: string) =>
        value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, char => char.toUpperCase());

    const formatBps = (value: number | null | undefined) =>
        value === null || value === undefined ? "--" : `${value.toFixed(1)} bps`;

    const formatUsd = (value: number | null | undefined) =>
        value === null || value === undefined ? "--" : `$${Math.round(value).toLocaleString()}`;

    const llmStatus = result?.llmStatus;
    const llmSkipped = llmStatus?.status === "skipped";
    const diagnostics = llmStatus?.diagnostics;
    const topRejectionCounts = diagnostics
        ? Object.entries(diagnostics.rejection_counts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 6)
        : [];

    return (
        <Card className="bg-slate-900 border-slate-800 flex flex-col flex-1 h-full border-0 rounded-none">
            <CardHeader className="pb-3 border-b border-slate-800/50 space-y-3" >
                <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-bold text-purple-400 flex items-center gap-2">
                        <BrainCircuit className="h-4 w-4" />
                        AI Trader Agent
                    </CardTitle>
                    <div className="flex items-center gap-2">
                        <Sheet open={showConfig} onOpenChange={setShowConfig}>
                            <SheetTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-6 w-6">
                                    <Settings className="h-4 w-4 text-slate-400" />
                                </Button>
                            </SheetTrigger>
                            <SheetContent side="right" className="w-[400px] sm:w-[540px] bg-slate-950/80 backdrop-blur-md border-slate-800 overflow-y-auto">
                                <SheetHeader>
                                    <SheetTitle className="text-slate-100">Agent Configuration</SheetTitle>
                                    <SheetDescription className="text-slate-400">
                                        Configure the AI Trader's risk management and decision logic.
                                    </SheetDescription>
                                </SheetHeader>
                                <div className="mt-6">
                                    <ConfigEditor
                                        initialConfig={customConfig || DEFAULT_AGENT_CONFIG}
                                        initialPreset={agentPreset}
                                        onSave={handleSaveConfig}
                                        onCancel={() => setShowConfig(false)}
                                    />
                                </div>
                            </SheetContent>
                        </Sheet>
                        <Badge variant={autoTrading ? "default" : "outline"} className={autoTrading ? "bg-green-500/20 text-green-400 border-green-500/50 text-xs" : "text-slate-500 text-xs"}>
                            {autoTrading ? <Play className="h-3 w-3 mr-1" /> : <Pause className="h-3 w-3 mr-1" />}
                            {autoTrading ? "Active" : "Paused"}
                        </Badge>
                    </div>
                </div>

                {/* Kill Switch - Always Visible & Accessible */}
                <Button
                    variant={killSwitch ? "outline" : "destructive"}
                    size="sm"
                    className={`w-full font-bold tracking-wider text-xs h-9 ${
                        killSwitch
                            ? "border-red-400 text-red-300 hover:bg-red-900/40"
                            : "bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-900/30"
                    }`}
                    onClick={handleKillSwitch}
                    disabled={killSwitch}
                >
                    <AlertOctagon className="h-3 w-3 mr-2" />
                    {killSwitch ? "SYSTEM HALTED" : "EMERGENCY STOP"}
                </Button>

                {/* Controls */}
                <div className="grid grid-cols-1 gap-3 bg-slate-900/80 p-3 rounded-lg border border-slate-700 shadow-inner">
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-200 font-semibold">Auto Trading</span>
                        <Switch
                            checked={autoTrading}
                            onCheckedChange={setAutoTrading}
                            disabled={killSwitch}
                            className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                        />
                    </div>

                    <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-200 font-semibold">Frequency</span>
                        <div className="flex items-center gap-2 text-slate-400">
                            <Input
                                type="number"
                                value={frequency}
                                onChange={(e) => setFrequency(Number(e.target.value))}
                                className="w-24 h-9 text-sm text-right bg-slate-800/80 border-slate-600 text-slate-100 focus-visible:ring-emerald-500 focus:border-emerald-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                            <span className="text-sm font-medium">sec</span>
                        </div>
                    </div>

                    <div className="space-y-1">
                        <span className="text-sm text-slate-200 font-semibold block">Model</span>
                        <Select value={selectedModel} onValueChange={setSelectedModel}>
                            <SelectTrigger className="w-full h-10 text-sm bg-slate-800/80 border-slate-600 text-slate-100 focus:ring-emerald-500 focus:border-emerald-500">
                                <SelectValue placeholder="Select Model" className="truncate" />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-900 border-slate-700 text-slate-100">
                                {availableModels.map(m => (
                                    <SelectItem
                                        key={m}
                                        value={m}
                                        title={m}
                                        className="focus:bg-slate-800 focus:text-emerald-400 text-sm"
                                    >
                                        {m}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </CardHeader>

            <CardContent className="flex-1 p-3 space-y-3 overflow-y-auto min-h-0">
                {/* Config is now in a Sheet, so we just show the main content */}
                <>
                    {loading && !result && (
                        <div className="flex flex-col items-center justify-center h-32 text-slate-500 gap-3">
                            <Loader2 className="h-6 w-6 animate-spin text-purple-500" />
                            <span className="text-xs animate-pulse">Analyzing market with model: {selectedModel}</span>
                            <Button
                                onClick={cancelAnalysis}
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs border-red-500/50 text-red-400 hover:bg-red-950/30 hover:border-red-500"
                            >
                                Cancel
                            </Button>
                        </div>
                    )}

                    {!result && !loading && (
                        <div className="flex flex-col items-center justify-center py-6 text-center space-y-3">
                            <div className="p-3 rounded-full bg-slate-950 border border-slate-800">
                                <BrainCircuit className="h-6 w-6 text-slate-600" />
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm text-slate-300 font-medium">Ready to Analyze</p>
                                <p className="text-xs text-slate-500 max-w-[200px] mx-auto">
                                    Enable Auto Trading or run a manual analysis to generate trading signals.
                                </p>
                            </div>
                            <Button onClick={analyzeMarket} className="w-full bg-purple-600 hover:bg-purple-700 text-white text-xs h-8">
                                <Play className="h-3 w-3 mr-2" />
                                Run Manual Analysis
                            </Button>
                        </div>
                    )}

                    {result && (
                        <div className="space-y-3 animate-fade-in">
                            {/* Portfolio Plan Header */}
                            <div className="p-3 bg-gradient-to-br from-slate-950 to-slate-900 rounded-lg border border-slate-800 shadow-lg">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Portfolio Plan</span>
                                    <Badge variant="outline" className="text-xs border-purple-500/30 text-purple-400 bg-purple-500/5">
                                        {result.decisions.length} Decision{result.decisions.length !== 1 ? 's' : ''}
                                    </Badge>
                                </div>
                            </div>

                            {llmSkipped && (
                                <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 space-y-3">
                                    <div className="flex items-start gap-2">
                                        <Ban className="h-4 w-4 text-amber-300 mt-0.5 shrink-0" />
                                        <div className="min-w-0 space-y-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="text-xs font-semibold text-amber-200">LLM Skipped</span>
                                                {llmStatus?.reason_code && (
                                                    <Badge variant="outline" className="text-[10px] border-amber-400/30 text-amber-200 bg-amber-400/10">
                                                        {formatDiagnosticLabel(llmStatus.reason_code)}
                                                    </Badge>
                                                )}
                                            </div>
                                            <p className="text-xs text-amber-100/80 leading-relaxed">
                                                {llmStatus?.reason || "The trader context had no actionable work for the model."}
                                            </p>
                                        </div>
                                    </div>

                                    {diagnostics && (
                                        <>
                                            <div className="grid grid-cols-2 gap-2">
                                                <div className="rounded border border-slate-700/70 bg-slate-950/40 px-2 py-1.5">
                                                    <span className="block text-[10px] uppercase text-slate-500">Screened</span>
                                                    <span className="text-xs font-mono text-slate-100">{diagnostics.screened_market_count}</span>
                                                </div>
                                                <div className="rounded border border-slate-700/70 bg-slate-950/40 px-2 py-1.5">
                                                    <span className="block text-[10px] uppercase text-slate-500">Eligible</span>
                                                    <span className="text-xs font-mono text-slate-100">{diagnostics.eligible_candidate_count}</span>
                                                </div>
                                                <div className="rounded border border-slate-700/70 bg-slate-950/40 px-2 py-1.5">
                                                    <span className="block text-[10px] uppercase text-slate-500">Positions</span>
                                                    <span className="text-xs font-mono text-slate-100">{diagnostics.held_position_count}</span>
                                                </div>
                                                <div className="rounded border border-slate-700/70 bg-slate-950/40 px-2 py-1.5">
                                                    <span className="block text-[10px] uppercase text-slate-500">Regime</span>
                                                    <span className="text-xs font-mono text-slate-100">{diagnostics.regime}</span>
                                                </div>
                                            </div>

                                            {topRejectionCounts.length > 0 && (
                                                <div className="space-y-1.5">
                                                    <div className="flex items-center gap-1.5">
                                                        <Info className="h-3.5 w-3.5 text-slate-400" />
                                                        <span className="text-[11px] font-semibold text-slate-300">Gate Blockers</span>
                                                    </div>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {topRejectionCounts.map(([reason, count]) => (
                                                            <Badge key={reason} variant="outline" className="text-[10px] border-slate-600/70 text-slate-300 bg-slate-950/40">
                                                                {formatDiagnosticLabel(reason)}: {count}
                                                            </Badge>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {diagnostics.top_rejections.length > 0 && (
                                                <div className="space-y-1.5">
                                                    <span className="text-[11px] font-semibold text-slate-300">Closest Rejected Markets</span>
                                                    <div className="space-y-1.5">
                                                        {diagnostics.top_rejections.slice(0, 4).map(rejection => (
                                                            <div key={`${rejection.symbol}-${rejection.reasons.join("-")}`} className="rounded border border-slate-700/60 bg-slate-950/40 px-2 py-1.5 space-y-1">
                                                                <div className="flex items-center justify-between gap-2">
                                                                    <span className="text-xs font-mono font-semibold text-slate-100 truncate">{rejection.symbol}</span>
                                                                    {rejection.rank !== null && (
                                                                        <span className="text-[10px] text-slate-500 shrink-0">Rank {rejection.rank}</span>
                                                                    )}
                                                                </div>
                                                                <div className="flex flex-wrap gap-1">
                                                                    {rejection.reasons.slice(0, 3).map(reason => (
                                                                        <Badge key={reason} variant="outline" className="text-[10px] border-red-500/30 text-red-300 bg-red-500/10">
                                                                            {formatDiagnosticLabel(reason)}
                                                                        </Badge>
                                                                    ))}
                                                                </div>
                                                                <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400">
                                                                    <span>Edge {formatBps(rejection.edge_bps)}</span>
                                                                    <span>Cost {formatBps(rejection.cost_bps)}</span>
                                                                    <span>Depth {formatUsd(rejection.min_depth_usd)}</span>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}

                            {result.decisions.length === 0 && !llmSkipped && (
                                <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/40 text-xs text-slate-400">
                                    No trade decisions were returned for this run.
                                </div>
                            )}

                            {/* Decisions List */}
                            <div className="space-y-2 pr-1">
                                {result.decisions.map((decision, idx) => (
                                    <div key={idx} className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800 hover:border-slate-700 transition-colors">
                                        <div className="flex items-center justify-between mb-1.5">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-mono font-bold text-slate-200">{decision.symbol || 'N/A'}</span>
                                                {decision.target_side && decision.target_side !== 'flat' && (
                                                    <Badge variant="outline" className={`text-xs px-1.5 py-0 ${decision.target_side === 'long'
                                                        ? 'border-green-500/50 text-green-400 bg-green-500/10'
                                                        : 'border-red-500/50 text-red-400 bg-red-500/10'
                                                        }`}>
                                                        {decision.target_side.toUpperCase()}
                                                    </Badge>
                                                )}
                                            </div>
                                            <Badge variant="outline" className={`text-xs px-1.5 py-0 ${decision.confidence > 0.7 ? 'border-green-500/30 text-green-400 bg-green-500/5' :
                                                decision.confidence > 0.5 ? 'border-yellow-500/30 text-yellow-400 bg-yellow-500/5' :
                                                    'border-slate-500/30 text-slate-400 bg-slate-500/5'
                                                }`}>
                                                {(decision.confidence * 100).toFixed(0)}%
                                            </Badge>
                                        </div>
                                        <div className="space-y-1">
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-slate-500">Action</span>
                                                <span className={`text-xs font-semibold ${decision.action === 'OPEN_POSITION' || decision.action === 'INCREASE_POSITION' ? 'text-green-400' :
                                                    decision.action === 'CLOSE_POSITION' || decision.action === 'REDUCE_POSITION' ? 'text-orange-400' :
                                                        'text-slate-400'
                                                    }`}>
                                                    {decision.action.replace(/_/g, ' ')}
                                                </span>
                                            </div>
                                            {decision.target_size_fraction_of_equity !== null && decision.target_size_fraction_of_equity !== undefined && (
                                                <div className="flex items-center justify-between">
                                                    <span className="text-xs text-slate-500">Target Size</span>
                                                    <span className="text-xs font-mono text-cyan-400">
                                                        {(decision.target_size_fraction_of_equity * 100).toFixed(1)}% equity
                                                    </span>
                                                </div>
                                            )}
                                            <div className="pt-1 border-t border-slate-800/50">
                                                <p className="text-xs text-slate-400 leading-relaxed break-words">
                                                    {decision.notes}
                                                </p>
                                            </div>

                                            {/* Audit Metrics */}
                                            {decision.audit && (
                                                <div className="grid grid-cols-3 gap-1 mt-2 p-1.5 bg-slate-900/50 rounded border border-slate-800/50">
                                                    <div className="flex flex-col">
                                                        <span className="text-[10px] text-slate-500 uppercase">Edge</span>
                                                        <span className={`text-xs font-mono ${decision.audit.edge_bps && decision.audit.edge_bps > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                            {decision.audit.edge_bps !== null && decision.audit.edge_bps !== undefined ? `${decision.audit.edge_bps.toFixed(0)} bps` : '--'}
                                                        </span>
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <span className="text-[10px] text-slate-500 uppercase">Cost</span>
                                                        <span className="text-xs font-mono text-slate-300">
                                                            {decision.audit.cost_bps !== null && decision.audit.cost_bps !== undefined ? `${decision.audit.cost_bps.toFixed(1)} bps` : '--'}
                                                        </span>
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <span className="text-[10px] text-slate-500 uppercase">Vol Ratio</span>
                                                        <span className={`text-xs font-mono ${decision.audit.vol_ratio_5m_vs_1h && decision.audit.vol_ratio_5m_vs_1h > 1.2 ? 'text-purple-400' : 'text-slate-300'}`}>
                                                            {decision.audit.vol_ratio_5m_vs_1h !== null && decision.audit.vol_ratio_5m_vs_1h !== undefined ? `${decision.audit.vol_ratio_5m_vs_1h.toFixed(2)}x` : '--'}
                                                        </span>
                                                    </div>
                                                </div>
                                            )}

                                            {/* Execution Button */}
                                            {(decision.action === "OPEN_POSITION" || decision.action === "INCREASE_POSITION" || decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION") && (
                                                <Button
                                                    onClick={() => executeDecision(decision, idx)}
                                                    disabled={executing === idx}
                                                    size="sm"
                                                    className={`w-full h-6 text-xs mt-2 ${decision.action.includes("CLOSE") || decision.action.includes("REDUCE")
                                                        ? "bg-orange-500/10 text-orange-400 border border-orange-500/50 hover:bg-orange-500/20"
                                                        : "bg-green-500/10 text-green-400 border border-green-500/50 hover:bg-green-500/20"
                                                        }`}
                                                >
                                                    {executing === idx ? (
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                    ) : (
                                                        <>
                                                            <Activity className="h-3 w-3 mr-1" />
                                                            EXECUTE {decision.action.split("_")[0]}
                                                        </>
                                                    )}
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Risk Assessments */}
                            {result.riskAssessments && result.riskAssessments.length > 0 && (
                                <div className="p-2.5 rounded-lg border border-slate-800/60 bg-slate-900/40">
                                    <div className="flex items-center gap-2 mb-2">
                                        <ShieldAlert className="h-4 w-4 text-sky-400" />
                                        <span className="text-xs font-semibold text-slate-100">Risk Checks</span>
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        {result.decisions.map((d, idx) => {
                                            const risk = result.riskAssessments[idx];
                                            if (!risk) return null;
                                            const pass = risk.approved;
                                            return (
                                                <div
                                                    key={`${d.symbol || 'N/A'}-${d.action}-${idx}`}
                                                    className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 px-2 py-1.5 rounded border ${pass ? 'border-green-900/40 bg-green-900/10' : 'border-red-900/40 bg-red-900/10'}`}
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <span className={`text-[11px] font-semibold ${pass ? 'text-green-300' : 'text-red-300'}`}>
                                                            {pass ? 'PASSED' : 'FAILED'}
                                                        </span>
                                                        <span className="text-[11px] text-slate-300">{d.symbol} · {d.action}</span>
                                                    </div>
                                                    <span className="text-[11px] text-slate-400 leading-relaxed">{risk.reason}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </>
            </CardContent>

            {/* Manual Analyze Button (Only visible if we have a result, to allow re-analysis) */}
            {
                result && !autoTrading && (
                    <div className="p-3 border-t border-slate-800/50 space-y-2">
                        <Button
                            onClick={analyzeMarket}
                            variant="outline"
                            disabled={loading}
                            className="w-full h-10 text-xs border border-sky-400/60 bg-gradient-to-r from-sky-600 to-blue-700 text-white hover:from-sky-500 hover:to-blue-600 shadow-lg shadow-sky-900/50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? (
                                <>
                                    <Loader2 className="h-3 w-3 mr-2 text-white animate-spin" />
                                    Analyzing...
                                </>
                            ) : (
                                <>
                                    <Play className="h-3 w-3 mr-2 text-white" />
                                    Re-Analyze Market
                                </>
                            )}
                        </Button>
                        <div className="grid grid-cols-2 gap-2">
                            <Button
                                onClick={() => {
                                    navigator.clipboard.writeText(result?.prompt || "");
                                }}
                                variant="outline"
                                className="w-full h-10 text-xs border border-slate-500/80 bg-[#111b2d] text-slate-50 hover:bg-[#18243c] hover:border-slate-300 shadow-md shadow-slate-900/40"
                            >
                                <span className="mr-2">📋</span>
                                Copy Prompt
                            </Button>
                            <Button
                                onClick={() => {
                                    navigator.clipboard.writeText(result?.rawOutput || "No raw output available");
                                }}
                                variant="outline"
                                className="w-full h-10 text-xs border border-slate-500/80 bg-[#111b2d] text-slate-50 hover:bg-[#18243c] hover:border-slate-300 shadow-md shadow-slate-900/40"
                            >
                                <span className="mr-2">🤖</span>
                                Copy Raw
                            </Button>
                        </div>
                    </div>
                )
            }
        </Card >
    )
}
