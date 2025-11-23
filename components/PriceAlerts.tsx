"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Bell, Plus, Trash2, ToggleLeft, ToggleRight, Loader2 } from "lucide-react"
import { useAccount } from "wagmi"
import { useTrading } from "@/context/TradingContext"

type AlertCondition = 'above' | 'below' | 'percent_change_up' | 'percent_change_down';

type PriceAlert = {
    id: string;
    symbol: string;
    condition: AlertCondition;
    targetPrice: number;
    percentChange?: number;
    isActive: boolean;
    triggered: boolean;
    createdAt: Date;
    triggeredAt?: Date;
};

export function PriceAlerts() {
    const { address } = useAccount()
    const { isTestnet } = useTrading()
    const [alerts, setAlerts] = useState<PriceAlert[]>([])
    const [loading, setLoading] = useState(false)
    const [creating, setCreating] = useState(false)

    // Form state
    const [symbol, setSymbol] = useState("BTC")
    const [condition, setCondition] = useState<AlertCondition>("above")
    const [targetPrice, setTargetPrice] = useState("")

    useEffect(() => {
        if (address) {
            fetchAlerts()
        }
    }, [address])

    const fetchAlerts = async () => {
        if (!address) return

        setLoading(true)
        try {
            const response = await fetch(`/api/alerts?userAddress=${address}&activeOnly=false`)
            const data = await response.json()
            if (data.alerts) {
                setAlerts(data.alerts)
            }
        } catch (error) {
            console.error("Failed to fetch alerts:", error)
        } finally {
            setLoading(false)
        }
    }

    const createAlert = async () => {
        if (!address || !targetPrice) return

        setCreating(true)
        try {
            const response = await fetch('/api/alerts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol,
                    condition,
                    targetPrice: parseFloat(targetPrice),
                    userAddress: address
                })
            })

            if (response.ok) {
                setTargetPrice("")
                await fetchAlerts()
            }
        } catch (error) {
            console.error("Failed to create alert:", error)
        } finally {
            setCreating(false)
        }
    }

    const deleteAlert = async (alertId: string) => {
        if (!address) return

        try {
            await fetch(`/api/alerts?alertId=${alertId}&userAddress=${address}`, {
                method: 'DELETE'
            })
            await fetchAlerts()
        } catch (error) {
            console.error("Failed to delete alert:", error)
        }
    }

    const toggleAlert = async (alertId: string) => {
        if (!address) return

        try {
            await fetch('/api/alerts', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    alertId,
                    userAddress: address,
                    action: 'toggle'
                })
            })
            await fetchAlerts()
        } catch (error) {
            console.error("Failed to toggle alert:", error)
        }
    }

    const getConditionLabel = (cond: AlertCondition) => {
        switch (cond) {
            case 'above': return '≥'
            case 'below': return '≤'
            case 'percent_change_up': return '+%'
            case 'percent_change_down': return '-%'
        }
    }

    return (
        <Card className="bg-slate-900 border-slate-800 hover-lift">
            <CardHeader className="pb-3 border-b border-slate-800/50">
                <CardTitle className="text-xl font-bold text-amber-400 flex items-center gap-2">
                    <Bell className="h-6 w-6" />
                    Price Alerts
                </CardTitle>
            </CardHeader>

            <CardContent className="p-3 space-y-3">
                {/* Create Alert Form */}
                <div className="p-2.5 bg-slate-950/50 rounded-lg border border-slate-800 space-y-2">
                    <span className="text-base font-semibold text-slate-300 block">Create New Alert</span>

                    <div className="grid grid-cols-2 gap-2">
                        <Input
                            placeholder="Symbol"
                            value={symbol}
                            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                            className="h-10 text-base bg-slate-900 border-slate-700 text-slate-200"
                        />
                        <Select value={condition} onValueChange={(v) => setCondition(v as AlertCondition)}>
                            <SelectTrigger className="h-10 text-base bg-slate-900 border-slate-700 text-slate-200">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-900 border-slate-700">
                                <SelectItem value="above" className="text-base">Price Above</SelectItem>
                                <SelectItem value="below" className="text-base">Price Below</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex gap-2">
                        <Input
                            type="number"
                            placeholder="Target Price"
                            value={targetPrice}
                            onChange={(e) => setTargetPrice(e.target.value)}
                            className="flex-1 h-10 text-base bg-slate-900 border-slate-700 text-slate-200"
                        />
                        <Button
                            onClick={createAlert}
                            disabled={!address || !targetPrice || creating}
                            className="h-10 px-4 bg-amber-600 hover:bg-amber-700 text-white text-base"
                        >
                            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                        </Button>
                    </div>
                </div>

                {/* Alerts List */}
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {loading && alerts.length === 0 && (
                        <div className="flex items-center justify-center h-20 text-slate-500">
                            <Loader2 className="h-4 w-4 animate-spin" />
                        </div>
                    )}

                    {!loading && alerts.length === 0 && (
                        <div className="text-center py-6 text-slate-500 text-base">
                            No alerts created yet
                        </div>
                    )}

                    {alerts.map((alert) => (
                        <div
                            key={alert.id}
                            className={`p-2 rounded-lg border transition-all ${alert.triggered
                                ? 'bg-green-950/20 border-green-900/30'
                                : alert.isActive
                                    ? 'bg-slate-950/50 border-slate-800'
                                    : 'bg-slate-950/30 border-slate-800/50 opacity-60'
                                }`}
                        >
                            <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-base font-mono font-bold text-slate-200">
                                        {alert.symbol}
                                    </span>
                                    {alert.triggered && (
                                        <Badge variant="outline" className="text-sm px-2.5 py-1 border-green-500/50 text-green-400 bg-green-500/10">
                                            TRIGGERED
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex items-center gap-1">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-6 p-0 hover:bg-slate-800"
                                        onClick={() => toggleAlert(alert.id)}
                                    >
                                        {alert.isActive ? (
                                            <ToggleRight className="h-3 w-3 text-green-400" />
                                        ) : (
                                            <ToggleLeft className="h-3 w-3 text-slate-500" />
                                        )}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-6 p-0 hover:bg-red-950 hover:text-red-400"
                                        onClick={() => deleteAlert(alert.id)}
                                    >
                                        <Trash2 className="h-3 w-3" />
                                    </Button>
                                </div>
                            </div>
                            <div className="text-sm text-slate-400">
                                {getConditionLabel(alert.condition)} ${alert.targetPrice.toFixed(2)}
                            </div>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    )
}
