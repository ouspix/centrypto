"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Copy, RefreshCw, Terminal, ChevronDown, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { useTrading } from "@/context/TradingContext"

interface LlmDecision {
    id: number
    action: string
    symbol: string
    confidence: number
    reasonCode: string | null
    notes: string | null
    side: string | null
    sizeFraction: number | null
}

interface LlmQuery {
    id: number
    prompt: string
    response: string
    createdAt: string
    decisions: LlmDecision[]
}

function HistoryItem({ item }: { item: LlmQuery }) {
    const [isOpen, setIsOpen] = useState(false)

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text)
        toast.success(`Copied ${label} to clipboard`)
    }

    const formatTime = (dateStr: string) => {
        const date = new Date(dateStr)
        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        })
    }

    return (
        <Card className="bg-slate-900/50 border-slate-800 transition-all hover:bg-slate-900/80">
            <div
                className="p-3 flex items-center justify-between cursor-pointer select-none"
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="flex items-center gap-3 overflow-hidden">
                    <div className="flex items-center gap-2 min-w-fit">
                        {isOpen ? (
                            <ChevronDown className="h-4 w-4 text-slate-500" />
                        ) : (
                            <ChevronRight className="h-4 w-4 text-slate-500" />
                        )}
                        <span className="text-xs font-mono text-slate-400">
                            {formatTime(item.createdAt)}
                        </span>
                    </div>

                    {/* Summary Badges (Visible when collapsed) */}
                    {!isOpen && (
                        <div className="flex items-center gap-2 overflow-hidden">
                            {item.decisions.length > 0 ? (
                                item.decisions.map((d, i) => (
                                    <Badge
                                        key={i}
                                        variant="outline"
                                        className={`text-[10px] h-5 px-1.5 whitespace-nowrap ${d.action === 'OPEN_POSITION' ? 'border-emerald-500/30 text-emerald-400' :
                                            d.action === 'CLOSE_POSITION' ? 'border-red-500/30 text-red-400' :
                                                'border-slate-700 text-slate-400'
                                            }`}
                                    >
                                        {d.action === 'OPEN_POSITION' ? 'OPEN' : d.action === 'CLOSE_POSITION' ? 'CLOSE' : d.action} {d.symbol}
                                    </Badge>
                                ))
                            ) : (
                                <span className="text-xs text-slate-600 italic">No actions</span>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {isOpen && (
                <CardContent className="px-3 pb-3 pt-0 space-y-3 border-t border-slate-800/50 mt-1">
                    {/* Prompt/Response Actions */}
                    <div className="flex justify-end gap-2 pt-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] border-slate-700 bg-slate-800/50 hover:bg-slate-700 text-slate-300 hover:text-slate-200"
                            onClick={(e) => {
                                e.stopPropagation()
                                copyToClipboard(item.prompt, "Prompt")
                            }}
                        >
                            <Copy className="h-3 w-3 mr-1" /> Prompt
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] border-slate-700 bg-slate-800/50 hover:bg-slate-700 text-slate-300 hover:text-slate-200"
                            onClick={(e) => {
                                e.stopPropagation()
                                copyToClipboard(item.response, "Response")
                            }}
                        >
                            <Copy className="h-3 w-3 mr-1" /> Response
                        </Button>
                    </div>

                    {/* Detailed Decisions */}
                    <div className="space-y-2">
                        {item.decisions.length > 0 ? (
                            item.decisions.map((decision, idx) => (
                                <div key={idx} className="flex flex-col gap-1 bg-slate-950/30 p-2 rounded border border-slate-800/50">
                            <div className="flex justify-between items-center">
                                <div className="flex items-center gap-2">
                                    <Badge variant="outline" className={`
                                        text-[10px] px-1.5 py-0
                                        ${decision.action === 'OPEN_POSITION' ? 'border-emerald-500/50 text-emerald-400' :
                                            decision.action === 'CLOSE_POSITION' ? 'border-red-500/50 text-red-400' :
                                                'border-slate-600 text-slate-400'}
                                    `}>
                                        {decision.action}
                                    </Badge>
                                    <span className="font-bold text-slate-200 text-sm">{decision.symbol}</span>
                                </div>
                                <span className="text-xs text-slate-500">
                                    {(() => {
                                        const hasConfidence = typeof decision.confidence === 'number' && decision.confidence > 0
                                        return `Conf: ${hasConfidence ? `${(decision.confidence * 100).toFixed(0)}%` : '—'}`
                                    })()}
                                </span>
                            </div>
                                    {decision.reasonCode && (
                                        <p className="text-xs text-slate-300 mt-0.5">
                                            <span className="text-slate-500">Reason:</span> {decision.reasonCode}
                                        </p>
                                    )}
                                    {decision.notes && (
                                        <p className="text-xs text-slate-400 italic mt-0.5">
                                            "{decision.notes}"
                                        </p>
                                    )}
                                </div>
                            ))
                        ) : (
                            <div className="text-xs text-slate-500 italic text-center py-1">
                                No trading decisions generated
                            </div>
                        )}
                    </div>
                </CardContent>
            )}
        </Card>
    )
}

export function LlmDecisionsLog({ className }: { className?: string }) {
    const { isTestnet } = useTrading()
    const [history, setHistory] = useState<LlmQuery[]>([])
    const [loading, setLoading] = useState(false)

    const fetchHistory = async () => {
        setLoading(true)
        try {
            const res = await fetch(`/api/llm/history?isTestnet=${isTestnet}`)
            if (res.ok) {
                const data = await res.json()
                setHistory(data)
            }
        } catch (error) {
            console.error("Failed to fetch history", error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchHistory()
    }, [isTestnet])

    return (
        <div className={`flex flex-col h-full space-y-3 ${className}`}>
            <div className="flex justify-between items-center px-1 flex-none">
                <h3 className="text-sm font-medium text-slate-300">Decision History</h3>
                <Button variant="ghost" size="icon" onClick={fetchHistory} disabled={loading} className="h-6 w-6">
                    <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                </Button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-0">
                {history.map((item) => (
                    <HistoryItem key={item.id} item={item} />
                ))}

                {history.length === 0 && !loading && (
                    <div className="text-center text-slate-500 py-8 text-sm">
                        No history available yet.
                    </div>
                )}
            </div>
        </div>
    )
}
