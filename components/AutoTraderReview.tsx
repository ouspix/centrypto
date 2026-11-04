"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertTriangle, RefreshCw, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useTrading } from "@/context/TradingContext"
import { toast } from "sonner"

type ReviewData = {
    warning: string
    summary: Summary
    attributedSummary: Summary
    unattributedSummary: { fillCount: number; exchangeTotalPnl: number; fees: number; symbols: number }
    openPositions: any[]
    closedLifecycles: any[]
    runs: any[]
    redFlags: any[]
    candidatePromotionImpact: any
    skippedOpportunities: any[]
    syncStatus: {
        fillCount: number
        lastFillAt: string | null
        unmatchedFillCount: number
        historicalUnmatchedFillCount?: number
        postReliableUnmatchedFillCount?: number
    }
    coverage: { reliableSince: string | null }
}

type Summary = {
    lifecycleCount: number
    closedCount: number
    openCount: number
    fillCount: number
    netPnl: number
    fees: number
    winRate: number
    profitFactor: number | null
    greenToRedCount: number
    lateGivebackCount: number
    avgHoldMinutes: number
}

export function AutoTraderReview({ className }: { className?: string }) {
    const { isTestnet, walletSessionAddress } = useTrading()
    const [data, setData] = useState<ReviewData | null>(null)
    const [loading, setLoading] = useState(false)
    const [syncing, setSyncing] = useState(false)
    const network = isTestnet ? "testnet" : "mainnet"

    const load = async () => {
        if (!walletSessionAddress) {
            setData(null)
            return
        }
        setLoading(true)
        try {
            const res = await fetch(`/api/auto-trader/review?network=${network}`)
            const payload = await res.json()
            if (!res.ok) throw new Error(payload.error || "Failed to load review")
            setData(payload)
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to load review")
        } finally {
            setLoading(false)
        }
    }

    const sync = async () => {
        if (!walletSessionAddress) return
        setSyncing(true)
        try {
            const res = await fetch("/api/auto-trader/review/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ network })
            })
            const payload = await res.json()
            if (!res.ok) throw new Error(payload.error || "Sync failed")
            toast.success(`Synced ${payload.upserted ?? 0} fills`)
            await load()
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Sync failed")
        } finally {
            setSyncing(false)
        }
    }

    useEffect(() => {
        load()
    }, [walletSessionAddress, network])

    const redFlagRows = useMemo(() => data?.redFlags?.slice(0, 8) ?? [], [data])
    const closedRows = useMemo(() => data?.closedLifecycles?.slice(0, 12) ?? [], [data])
    const promotionImpact = data?.candidatePromotionImpact
    const promotionEvents = useMemo(() => promotionImpact?.events?.slice(0, 8) ?? [], [promotionImpact])

    if (!walletSessionAddress) {
        return (
            <div className={`p-4 text-sm text-slate-500 ${className ?? ""}`}>
                Authenticate wallet session to review auto-trader activity.
            </div>
        )
    }

    return (
        <div className={`flex flex-col h-full min-h-0 ${className ?? ""}`}>
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 p-3">
                <Badge variant="outline" className="h-8 border-slate-700 bg-slate-950 px-3 text-xs text-slate-200">
                    Last 24h
                </Badge>
                <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={load} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 text-xs" onClick={sync} disabled={syncing}>
                        <RotateCw className={`h-3.5 w-3.5 mr-1 ${syncing ? "animate-spin" : ""}`} />
                        Sync
                    </Button>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                {data?.warning && (
                    <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200 flex gap-2">
                        <AlertTriangle className="h-4 w-4 flex-none" />
                        <span>{data.warning}</span>
                    </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                    <MetricCard label="Attributed PnL" value={formatUsd(data?.attributedSummary.netPnl)} tone={(data?.attributedSummary.netPnl ?? 0) >= 0 ? "good" : "bad"} />
                    <MetricCard label="Exchange PnL" value={formatUsd(data?.summary.netPnl)} tone={(data?.summary.netPnl ?? 0) >= 0 ? "good" : "bad"} />
                    <MetricCard label="Green to red" value={String(data?.summary.greenToRedCount ?? 0)} tone={(data?.summary.greenToRedCount ?? 0) > 0 ? "bad" : "muted"} />
                    <MetricCard label="Late giveback" value={String(data?.summary.lateGivebackCount ?? 0)} tone={(data?.summary.lateGivebackCount ?? 0) > 0 ? "bad" : "muted"} />
                    <MetricCard label="Win rate" value={`${(data?.attributedSummary.winRate ?? 0).toFixed(1)}%`} />
                    <MetricCard
                        label="Live unmatched"
                        value={String(data?.syncStatus.postReliableUnmatchedFillCount ?? data?.syncStatus.unmatchedFillCount ?? 0)}
                        tone={(data?.syncStatus.postReliableUnmatchedFillCount ?? data?.syncStatus.unmatchedFillCount ?? 0) > 0 ? "warn" : "muted"}
                    />
                    <MetricCard
                        label="Historical unmatched"
                        value={String(data?.syncStatus.historicalUnmatchedFillCount ?? 0)}
                        tone={(data?.syncStatus.historicalUnmatchedFillCount ?? 0) > 0 ? "warn" : "muted"}
                    />
                    <MetricCard label="Synced fills" value={String(data?.syncStatus.fillCount ?? 0)} />
                </div>

                <Section title="Candidate Promotion Impact">
                    <div className="grid grid-cols-2 gap-2 p-3">
                        <MiniMetric label="Shadow" value={String(promotionImpact?.shadowMatches ?? 0)} />
                        <MiniMetric label="Live matches" value={String(promotionImpact?.livePromotions ?? 0)} tone={(promotionImpact?.livePromotions ?? 0) > 0 ? "good" : "muted"} />
                        <MiniMetric label="Promoted" value={String(promotionImpact?.promotedCandidates ?? 0)} tone={(promotionImpact?.promotedCandidates ?? 0) > 0 ? "good" : "muted"} />
                        <MiniMetric label="Demoted" value={String(promotionImpact?.demotions ?? 0)} tone={(promotionImpact?.demotions ?? 0) > 0 ? "warn" : "muted"} />
                        <MiniMetric label="Promoted 1h avg" value={formatBps(promotionImpact?.avgPromotedCandidate1hNetBps)} tone={(promotionImpact?.avgPromotedCandidate1hNetBps ?? 0) > 0 ? "good" : (promotionImpact?.avgPromotedCandidate1hNetBps ?? 0) < 0 ? "bad" : "muted"} />
                    </div>
                    {promotionEvents.length === 0 ? <Empty /> : promotionEvents.map((row: any) => (
                        <CompactRow key={row.id}
                            left={`${row.symbol} ${row.side}${row.playbook ? ` ${row.playbook}` : ""}`}
                            right={formatPromotionEventType(row)}
                            sub={`${formatReason(row.promotionReason ?? row.demotionReason)} | 1h ${formatBps(row.outcome1hNetBps)} | ${row.pathQuality ?? "path pending"} | ${row.policyOutcome ?? "policy pending"} | ${formatTime(row.timestamp)}`}
                            bad={row.impactType === "DEMOTION" || Number(row.outcome1hNetBps ?? 0) < 0}
                        />
                    ))}
                </Section>

                <Section title="Open Positions">
                    {(data?.openPositions ?? []).length === 0 ? <Empty /> : data!.openPositions.slice(0, 8).map(row => (
                        <CompactRow key={row.id}
                            left={`${row.symbol} ${row.side}`}
                            right={formatUsd(row.currentUnrealizedPnl)}
                            sub={`Peak ${formatUsd(row.observedPeakPnl)} | Giveback ${formatPct(row.openGivebackPct)} | ${row.openWasGreenNowRed ? "green-to-red" : row.openLateGiveback ? "late giveback" : row.attributionMethod}`}
                            bad={row.openWasGreenNowRed || row.openLateGiveback}
                        />
                    ))}
                </Section>

                <Section title="Red Flags">
                    {redFlagRows.length === 0 ? <Empty /> : redFlagRows.map(row => (
                        <CompactRow key={row.id}
                            left={`${row.symbol} ${row.side}`}
                            right={formatUsd(row.netRealizedPnl)}
                            sub={`MFE ${formatBps(row.mfeBps)} | Giveback ${formatPct(row.givebackPct)} | ${row.attributionMethod}`}
                            bad
                        />
                    ))}
                </Section>

                <Section title="Closed Trades">
                    {closedRows.length === 0 ? <Empty /> : closedRows.map(row => (
                        <CompactRow key={row.id}
                            left={`${row.symbol} ${row.side}`}
                            right={formatUsd(row.netRealizedPnl)}
                            sub={`MFE ${formatBps(row.mfeBps)} | MAE ${formatBps(row.maeBps)} | ${row.mfeCoverage}`}
                            bad={Number(row.netRealizedPnl ?? 0) < 0}
                        />
                    ))}
                </Section>

                <Section title="Skipped Opportunities">
                    {(data?.skippedOpportunities ?? []).length === 0 ? <Empty /> : data!.skippedOpportunities.slice(0, 8).map(row => (
                        <CompactRow key={row.id}
                            left={`${row.symbol} ${row.side}`}
                            right={row.validatorStatus ?? "skip"}
                            sub={(row.outcomes ?? []).map((outcome: any) => `${outcome.minutes}m ${formatBps(outcome.bps)}`).join(" | ")}
                        />
                    ))}
                </Section>

                <Section title="Run Timeline">
                    {(data?.runs ?? []).length === 0 ? <Empty /> : data!.runs.slice(0, 8).map(run => (
                        <CompactRow key={run.id}
                            left={formatTime(run.startedAt)}
                            right={run.status}
                            sub={`${run.decisionCount} decisions | ${run.orderAttemptCount} orders | ${run.model}`}
                            bad={run.status === "FAILED"}
                        />
                    ))}
                </Section>
            </div>
        </div>
    )
}

function MiniMetric({ label, value, tone = "muted" }: { label: string; value: string; tone?: "good" | "bad" | "warn" | "muted" }) {
    const color = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : tone === "warn" ? "text-amber-300" : "text-slate-200"
    return (
        <div className="rounded border border-slate-800 bg-slate-950/50 p-2">
            <div className="text-[10px] uppercase text-slate-500">{label}</div>
            <div className={`mt-0.5 font-mono text-sm font-semibold ${color}`}>{value}</div>
        </div>
    )
}

function MetricCard({ label, value, tone = "muted" }: { label: string; value: string; tone?: "good" | "bad" | "warn" | "muted" }) {
    const color = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : tone === "warn" ? "text-amber-300" : "text-slate-200"
    return (
        <Card className="bg-slate-950/50 border-slate-800">
            <CardContent className="p-3">
                <div className="text-[11px] text-slate-500">{label}</div>
                <div className={`text-base font-mono font-semibold ${color}`}>{value}</div>
            </CardContent>
        </Card>
    )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <Card className="bg-slate-950/40 border-slate-800">
            <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm text-slate-300">{title}</CardTitle>
            </CardHeader>
            <CardContent className="p-0 divide-y divide-slate-800/70">{children}</CardContent>
        </Card>
    )
}

function CompactRow({ left, right, sub, bad = false }: { left: string; right: string; sub?: string; bad?: boolean }) {
    return (
        <div className="p-3">
            <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-slate-200 truncate">{left}</div>
                <Badge variant="outline" className={`text-[10px] ${bad ? "border-red-500/40 text-red-300" : "border-slate-700 text-slate-300"}`}>
                    {right}
                </Badge>
            </div>
            {sub && <div className="mt-1 text-[11px] text-slate-500 truncate">{sub}</div>}
        </div>
    )
}

function Empty() {
    return <div className="p-3 text-xs text-slate-600">No records</div>
}

function formatUsd(value: number | null | undefined) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--"
    const number = Number(value)
    return `${number >= 0 ? "+" : "-"}$${Math.abs(number).toFixed(2)}`
}

function formatBps(value: number | null | undefined) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--"
    return `${Number(value).toFixed(1)} bps`
}

function formatPct(value: number | null | undefined) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--"
    return `${Number(value).toFixed(1)}%`
}

function formatReason(value: string | null | undefined) {
    if (!value) return "no reason"
    return value.replace(/_/g, " ").replace(/:/g, " ").toLowerCase().replace(/\b\w/g, char => char.toUpperCase())
}

function formatPromotionEventType(row: any) {
    if (row?.promotionApplied) return "PROMOTED"
    if (row?.impactType === "LIVE_PROMOTION") return "LIVE"
    if (row?.impactType === "DEMOTION") return "DEMOTE"
    if (row?.impactType === "SHADOW") return "SHADOW"
    return "MATCH"
}

function formatTime(value: string) {
    return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}
