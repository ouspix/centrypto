"use client"

import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, ColorType, IChartApi, CandlestickSeries, HistogramSeries, LineSeries, Time, TickMarkType } from 'lightweight-charts'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Toggle } from "@/components/ui/toggle"
import { useTrading } from "@/context/TradingContext"
import { Loader2 } from "lucide-react"

const TIMEFRAMES = [
    { label: '1m', value: '1m' },
    { label: '5m', value: '5m' },
    { label: '15m', value: '15m' },
    { label: '1h', value: '1h' },
    { label: '4h', value: '4h' },
]

export function TechnicalChart() {
    const chartContainerRef = useRef<HTMLDivElement>(null)
    const chartRef = useRef<IChartApi | null>(null)
    const { selectedPair, isTestnet } = useTrading()

    const [interval, setTimeframe] = useState('1h')
    const [isLoading, setIsLoading] = useState(false)

    // Indicator States
    const [showVolume, setShowVolume] = useState(true)
    const [showSMA20, setShowSMA20] = useState(false)
    const [showSMA50, setShowSMA50] = useState(false)
    const [showRSI, setShowRSI] = useState(false) // Placeholder for future RSI sub-chart

    // Series Refs
    const candleSeriesRef = useRef<any>(null)
    const volumeSeriesRef = useRef<any>(null)
    const sma20SeriesRef = useRef<any>(null)
    const sma50SeriesRef = useRef<any>(null)

    const calculateSMA = (data: any[], period: number) => {
        const smaData = []
        for (let i = period - 1; i < data.length; i++) {
            const slice = data.slice(i - period + 1, i + 1)
            const sum = slice.reduce((acc: number, val: any) => acc + val.close, 0)
            smaData.push({
                time: data[i].time,
                value: sum / period
            })
        }
        return smaData
    }

    const fetchData = useCallback(async () => {
        if (!selectedPair) return
        setIsLoading(true)
        try {
            const response = await fetch(`/api/candles?symbol=${selectedPair}&interval=${interval}&isTestnet=${isTestnet}&_t=${Date.now()}`)
            if (!response.ok) throw new Error('Failed to fetch candles')

            const data = await response.json()

            if (chartRef.current && candleSeriesRef.current) {
                candleSeriesRef.current.setData(data)

                if (volumeSeriesRef.current) {
                    const volumeData = data.map((d: any) => ({
                        time: d.time,
                        value: d.volume,
                        color: d.close >= d.open ? '#22c55e80' : '#ef444480'
                    }))
                    volumeSeriesRef.current.setData(volumeData)
                }

                if (sma20SeriesRef.current) {
                    const sma20 = calculateSMA(data, 20)
                    sma20SeriesRef.current.setData(sma20)
                }

                if (sma50SeriesRef.current) {
                    const sma50 = calculateSMA(data, 50)
                    sma50SeriesRef.current.setData(sma50)
                }
            }
        } catch (error) {
            console.error("Error fetching candles:", error)
        } finally {
            setIsLoading(false)
        }
    }, [selectedPair, interval, isTestnet])

    // Initialize Chart
    useEffect(() => {
        if (!chartContainerRef.current) return

        const chart = createChart(chartContainerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: '#94a3b8',
            },
            grid: {
                vertLines: { color: '#1e293b' },
                horzLines: { color: '#1e293b' },
            },
            width: chartContainerRef.current.clientWidth,
            height: 400,
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (time: number, tickMarkType: TickMarkType, locale: string) => {
                    const date = new Date(time * 1000);
                    switch (tickMarkType) {
                        case TickMarkType.Year:
                            return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric' }).format(date);
                        case TickMarkType.Month:
                            return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', month: 'short' }).format(date);
                        case TickMarkType.DayOfMonth:
                            return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short' }).format(date);
                        case TickMarkType.Time:
                        case TickMarkType.TimeWithSeconds:
                            return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
                        default:
                            return "";
                    }
                },
            },
            localization: {
                timeFormatter: (time: number) => {
                    return new Date(time * 1000).toLocaleString('fr-FR', {
                        timeZone: 'Europe/Paris',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                    });
                }
            },
            // Hide the TradingView logo/watermark if possible (attribution is usually required for free version, but we can try to style it)
            // Lightweight charts doesn't have a direct 'hide' option for the logo in the free version without attribution, 
            // but we can ensure it doesn't overlap important data.
        })

        // Candle Series
        const candlestickSeries = chart.addSeries(CandlestickSeries, {
            upColor: '#22c55e',
            downColor: '#ef4444',
            borderVisible: false,
            wickUpColor: '#22c55e',
            wickDownColor: '#ef4444',
        })
        candleSeriesRef.current = candlestickSeries

        // Volume Series
        const volumeSeries = chart.addSeries(HistogramSeries, {
            color: '#26a69a',
            priceFormat: {
                type: 'volume',
            },
            priceScaleId: '', // Overlay on main chart
        })
        volumeSeries.priceScale().applyOptions({
            scaleMargins: {
                top: 0.7, // Make volume bars taller (take up bottom 30%)
                bottom: 0,
            },
        })
        volumeSeriesRef.current = volumeSeries

        // SMA Series
        const sma20Series = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 2, visible: false })
        sma20SeriesRef.current = sma20Series

        const sma50Series = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2, visible: false })
        sma50SeriesRef.current = sma50Series

        chartRef.current = chart

        const handleResize = () => {
            if (chartContainerRef.current) {
                chart.applyOptions({ width: chartContainerRef.current.clientWidth })
            }
        }

        window.addEventListener('resize', handleResize)

        return () => {
            window.removeEventListener('resize', handleResize)
            chart.remove()
        }
    }, [])

    // Update Visibility
    useEffect(() => {
        if (volumeSeriesRef.current) {
            volumeSeriesRef.current.applyOptions({ visible: showVolume })
        }
        if (sma20SeriesRef.current) {
            sma20SeriesRef.current.applyOptions({ visible: showSMA20 })
        }
        if (sma50SeriesRef.current) {
            sma50SeriesRef.current.applyOptions({ visible: showSMA50 })
        }
    }, [showVolume, showSMA20, showSMA50])

    // Fetch Data on Change
    useEffect(() => {
        const timer = setTimeout(() => {
            fetchData()
        }, 500) // Debounce fetches by 500ms
        return () => clearTimeout(timer)
    }, [fetchData])

    // Auto-refresh every minute
    useEffect(() => {
        const intervalId = window.setInterval(() => {
            console.log('[TechnicalChart] Auto-refreshing data...')
            fetchData()
        }, 60000)
        return () => { window.clearInterval(intervalId) }
    }, [fetchData])

    return (
        <Card className="bg-slate-900 border-slate-800 col-span-2 flex flex-col h-full">
            <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0 pb-4 border-b border-slate-800/50">
                <div className="flex flex-col">
                    <CardTitle className="text-slate-100 text-lg font-semibold tracking-tight">
                        {selectedPair} / USD
                    </CardTitle>
                    <span className="text-xs text-slate-500 font-mono mt-1">Technical Analysis</span>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    {/* Timeframe Selector */}
                    <div className="flex bg-slate-950/50 rounded-lg p-1 border border-slate-800">
                        {TIMEFRAMES.map((tf) => (
                            <button
                                key={tf.value}
                                onClick={() => setTimeframe(tf.value)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${interval === tf.value
                                    ? 'bg-slate-800 text-white shadow-sm'
                                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                                    }`}
                            >
                                {tf.label}
                            </button>
                        ))}
                    </div>

                    <div className="h-6 w-px bg-slate-800 mx-1 hidden sm:block" />

                    {/* Indicators */}
                    <div className="flex items-center gap-2">
                        <Toggle
                            pressed={showVolume}
                            onPressedChange={setShowVolume}
                            size="sm"
                            className="h-8 px-3 text-xs font-medium border border-slate-800 data-[state=on]:bg-slate-800 data-[state=on]:text-emerald-400 data-[state=on]:border-emerald-500/30 hover:bg-slate-800/50 text-slate-400"
                        >
                            Vol
                        </Toggle>
                        <Toggle
                            pressed={showSMA20}
                            onPressedChange={setShowSMA20}
                            size="sm"
                            className="h-8 px-3 text-xs font-medium border border-slate-800 data-[state=on]:bg-slate-800 data-[state=on]:text-blue-400 data-[state=on]:border-blue-500/30 hover:bg-slate-800/50 text-slate-400"
                        >
                            SMA 20
                        </Toggle>
                        <Toggle
                            pressed={showSMA50}
                            onPressedChange={setShowSMA50}
                            size="sm"
                            className="h-8 px-3 text-xs font-medium border border-slate-800 data-[state=on]:bg-slate-800 data-[state=on]:text-amber-400 data-[state=on]:border-amber-500/30 hover:bg-slate-800/50 text-slate-400"
                        >
                            SMA 50
                        </Toggle>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 p-0 relative">
                {isLoading && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/50 backdrop-blur-[1px]">
                        <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
                    </div>
                )}
                <div ref={chartContainerRef} className="w-full h-[450px]" />
            </CardContent>
        </Card>
    )
}
