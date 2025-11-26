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
import { BrainCircuit, Play, Pause, AlertOctagon, Loader2, Activity, ShieldAlert, Settings } from "lucide-react"
import { useTrading } from "@/context/TradingContext"
import { ConfigEditor } from "@/components/ui/ConfigEditor"
import { AgentConfig, DEFAULT_AGENT_CONFIG } from "@/lib/agent-config"

// ... (inside AIAdvisor component)

type TradeDecision = {
    action: "OPEN_POSITION" | "CLOSE_POSITION" | "REDUCE_POSITION" | "ADJUST_STOPS" | "DO_NOTHING" | "HOLD" | "INCREASE_POSITION";
    symbol: string | null;
    side: "long" | "short" | null;
    target_side: "long" | "short" | "flat" | null;
    target_size_fraction_of_equity: number | null;
    size_fraction_of_equity: number | null;
    risk_plan: {
        stop_loss_pct: number;
        take_profit_pct_primary: number;
    } | null;
    playbook: string;
    confidence: number;
    reason_code: string;
    notes: string;
    audit?: {
        cost_bps: number;
        expected_move_bps: number;
        edge_bps: number;
        book_pressure: number;
        vol_ratio_5m_vs_1h: number;
        ret_sigma_5m_vs_1h: number;
    };
};

type RiskAssessment = {
    approved: boolean;
    reason: string;
};

type AnalysisResult = {
    decisions: TradeDecision[];
    riskAssessment: RiskAssessment;
    snapshot: any;
    prompt: string;
    rawOutput: string;
};

export function AIAdvisor() {
    const { isTestnet } = useTrading()
    const { address } = useAccount()
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<AnalysisResult | null>(null)
    const [executing, setExecuting] = useState<number | null>(null)

    const executeDecision = async (decision: TradeDecision, index: number) => {
        if (!result || !result.snapshot) return;
        setExecuting(index);

        try {
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
                const size = sizeUsd / price;

                if (isNaN(size) || size <= 0) {
                    throw new Error(`Invalid calculated size: ${size} (USD: ${sizeUsd}, Price: ${price})`);
                }

                const isBuy = decision.target_side === "long";

                // Aggressive limit price (5% buffer) to ensure fill
                const limitPx = isBuy ? price * 1.05 : price * 0.95;

                orderRequest = {
                    asset: assetIndex,
                    isBuy,
                    limitPx,
                    sz: size,
                    reduceOnly: false
                };
            } else if (decision.action === "CLOSE_POSITION" || decision.action === "REDUCE_POSITION") {
                // Find current position size
                const position = result.snapshot.account.current_positions.find((p: any) => p.symbol === decision.symbol);
                if (!position) throw new Error("No open position to close");

                // Use the exact coin size from the snapshot if available, otherwise fallback (though snapshot should have it now)
                const sizeToClose = position.size_coin !== undefined
                    ? position.size_coin
                    : Math.abs(Number(position.size_usd) / price); // Fallback estimate

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
    const DEFAULT_TRADING_INTERVAL = 600; // 10 minutes
    const [frequency, setFrequency] = useState(DEFAULT_TRADING_INTERVAL) // seconds
    const [selectedModel, setSelectedModel] = useState("deepseek/deepseek-v3.2-exp")
    const [availableModels, setAvailableModels] = useState<string[]>([])
    const [killSwitch, setKillSwitch] = useState(false)
    const [showConfig, setShowConfig] = useState(false)
    const [customConfig, setCustomConfig] = useState<AgentConfig | undefined>(undefined)

    const timerRef = useRef<NodeJS.Timeout | null>(null)
    const abortControllerRef = useRef<AbortController | null>(null)

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
    }, [])

    const handleSaveConfig = (newConfig: AgentConfig) => {
        setCustomConfig(newConfig);
        localStorage.setItem('agentConfig', JSON.stringify(newConfig));
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

        // Create new AbortController for this request
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

            const response = await fetch('/api/ai/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userAddress: address || null,
                    autoTrading: autoTrading,
                    screeningConfig,
                    configOverride: customConfig
                }),
                signal: abortControllerRef.current.signal
            })

            if (!response.ok) {
                throw new Error('Analysis failed')
            }

            const data = await response.json()
            setResult(data)
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                console.log("Analysis cancelled by user")
            } else {
                console.error("Analysis failed", error)
            }
        } finally {
            setLoading(false)
            abortControllerRef.current = null;
        }
    }

    const cancelAnalysis = async () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setLoading(false);
        }

        // Also call the backend cancel endpoint
        try {
            await fetch('/api/ai/cancel', { method: 'POST' });
            console.log('✅ Backend cancellation requested');
        } catch (error) {
            console.error('Failed to cancel backend request:', error);
        }
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

    return (
        <Card className="bg-slate-900 border-slate-800 hover-lift flex flex-col h-full">
            <CardHeader className="pb-3 border-b border-slate-800/50 space-y-3">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-bold text-purple-400 flex items-center gap-2">
                        <BrainCircuit className="h-4 w-4" />
                        AI Trader Agent
                    </CardTitle>
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowConfig(!showConfig)}>
                            <Settings className="h-4 w-4 text-slate-400" />
                        </Button>
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
                    className={`w-full font-bold tracking-wider text-xs h-8 ${killSwitch ? "border-red-500 text-red-500 hover:bg-red-950" : "bg-red-600 hover:bg-red-700"}`}
                    onClick={handleKillSwitch}
                    disabled={killSwitch}
                >
                    <AlertOctagon className="h-3 w-3 mr-2" />
                    {killSwitch ? "SYSTEM HALTED" : "EMERGENCY STOP"}
                </Button>

                {/* Controls */}
                <div className="grid grid-cols-1 gap-2.5 bg-slate-950/50 p-2.5 rounded-lg border border-slate-800">
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-400 font-medium">Auto Trading</span>
                        <Switch
                            checked={autoTrading}
                            onCheckedChange={setAutoTrading}
                            disabled={killSwitch}
                            className="data-[state=checked]:bg-green-500"
                        />
                    </div>

                    <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-400 font-medium">Frequency</span>
                        <div className="flex items-center gap-2">
                            <Input
                                type="number"
                                value={frequency}
                                onChange={(e) => setFrequency(Number(e.target.value))}
                                className="w-16 h-7 text-xs text-right bg-slate-900 border-slate-700 focus-visible:ring-purple-500"
                            />
                            <span className="text-xs text-slate-500">sec</span>
                        </div>
                    </div>

                    <div className="space-y-1">
                        <span className="text-xs text-slate-400 font-medium block">Model</span>
                        <Select value={selectedModel} onValueChange={setSelectedModel}>
                            <SelectTrigger className="w-full h-8 text-xs bg-slate-900 border-slate-700 text-slate-200 focus:ring-purple-500">
                                <SelectValue placeholder="Select Model" />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-900 border-slate-700 text-slate-200">
                                {availableModels.map(m => (
                                    <SelectItem key={m} value={m} className="focus:bg-slate-800 focus:text-purple-400 text-xs">{m}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </CardHeader>

            <CardContent className="flex-1 overflow-y-auto p-3 space-y-3">
                {showConfig ? (
                    <ConfigEditor
                        initialConfig={customConfig || DEFAULT_AGENT_CONFIG}
                        onSave={handleSaveConfig}
                        onCancel={() => setShowConfig(false)}
                    />
                ) : (
                    <>
                        {loading && !result && (
                            <div className="flex flex-col items-center justify-center h-32 text-slate-500 gap-3">
                                <Loader2 className="h-6 w-6 animate-spin text-purple-500" />
                                <span className="text-xs animate-pulse">Calling LLM with model: {selectedModel}</span>
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
                                        <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Portfolio Plan</span>
                                        <Badge variant="outline" className="text-[9px] border-purple-500/30 text-purple-400 bg-purple-500/5">
                                            {result.decisions.length} Decision{result.decisions.length !== 1 ? 's' : ''}
                                        </Badge>
                                    </div>
                                </div>

                                {/* Decisions List */}
                                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                                    {result.decisions.map((decision, idx) => (
                                        <div key={idx} className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800 hover:border-slate-700 transition-colors">
                                            <div className="flex items-center justify-between mb-1.5">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-mono font-bold text-slate-200">{decision.symbol || 'N/A'}</span>
                                                    {decision.target_side && decision.target_side !== 'flat' && (
                                                        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${decision.target_side === 'long'
                                                            ? 'border-green-500/50 text-green-400 bg-green-500/10'
                                                            : 'border-red-500/50 text-red-400 bg-red-500/10'
                                                            }`}>
                                                            {decision.target_side.toUpperCase()}
                                                        </Badge>
                                                    )}
                                                </div>
                                                <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${decision.confidence > 0.7 ? 'border-green-500/30 text-green-400 bg-green-500/5' :
                                                    decision.confidence > 0.5 ? 'border-yellow-500/30 text-yellow-400 bg-yellow-500/5' :
                                                        'border-slate-500/30 text-slate-400 bg-slate-500/5'
                                                    }`}>
                                                    {(decision.confidence * 100).toFixed(0)}%
                                                </Badge>
                                            </div>
                                            <div className="space-y-1">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-[10px] text-slate-500">Action</span>
                                                    <span className={`text-[10px] font-semibold ${decision.action === 'OPEN_POSITION' || decision.action === 'INCREASE_POSITION' ? 'text-green-400' :
                                                        decision.action === 'CLOSE_POSITION' || decision.action === 'REDUCE_POSITION' ? 'text-orange-400' :
                                                            'text-slate-400'
                                                        }`}>
                                                        {decision.action.replace(/_/g, ' ')}
                                                    </span>
                                                </div>
                                                {decision.target_size_fraction_of_equity !== null && decision.target_size_fraction_of_equity !== undefined && (
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-[10px] text-slate-500">Target Size</span>
                                                        <span className="text-[10px] font-mono text-cyan-400">
                                                            {(decision.target_size_fraction_of_equity * 100).toFixed(1)}% equity
                                                        </span>
                                                    </div>
                                                )}
                                                <div className="pt-1 border-t border-slate-800/50">
                                                    <p className="text-[10px] text-slate-400 leading-relaxed">
                                                        {decision.notes}
                                                    </p>
                                                </div>

                                                {/* Audit Metrics */}
                                                {decision.audit && (
                                                    <div className="grid grid-cols-3 gap-1 mt-2 p-1.5 bg-slate-900/50 rounded border border-slate-800/50">
                                                        <div className="flex flex-col">
                                                            <span className="text-[8px] text-slate-500 uppercase">Edge</span>
                                                            <span className={`text-[9px] font-mono ${decision.audit.edge_bps > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                                {decision.audit.edge_bps.toFixed(0)} bps
                                                            </span>
                                                        </div>
                                                        <div className="flex flex-col">
                                                            <span className="text-[8px] text-slate-500 uppercase">Cost</span>
                                                            <span className="text-[9px] font-mono text-slate-300">
                                                                {decision.audit.cost_bps.toFixed(1)} bps
                                                            </span>
                                                        </div>
                                                        <div className="flex flex-col">
                                                            <span className="text-[8px] text-slate-500 uppercase">Vol Ratio</span>
                                                            <span className={`text-[9px] font-mono ${decision.audit.vol_ratio_5m_vs_1h > 1.2 ? 'text-purple-400' : 'text-slate-300'}`}>
                                                                {decision.audit.vol_ratio_5m_vs_1h.toFixed(2)}x
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
                                                        className={`w-full h-6 text-[10px] mt-2 ${decision.action.includes("CLOSE") || decision.action.includes("REDUCE")
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

                                {/* Risk Assessment */}
                                <div className={`p-2.5 rounded-lg border flex items-start gap-2 ${result.riskAssessment.approved
                                    ? 'bg-green-950/10 border-green-900/30'
                                    : 'bg-red-950/10 border-red-900/30'
                                    }`}>
                                    <ShieldAlert className={`h-4 w-4 shrink-0 mt-0.5 ${result.riskAssessment.approved ? 'text-green-500' : 'text-red-500'}`} />
                                    <div className="flex flex-col">
                                        <span className={`text-xs font-bold ${result.riskAssessment.approved ? 'text-green-400' : 'text-red-400'}`}>
                                            Risk: {result.riskAssessment.approved ? 'PASSED' : 'FAILED'}
                                        </span>
                                        <span className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{result.riskAssessment.reason}</span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}
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
