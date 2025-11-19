"use client"

import { useEffect, useRef } from 'react'
import { createChart, ColorType, IChartApi, CandlestickSeries } from 'lightweight-charts'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useTrading } from "@/context/TradingContext"

export function TechnicalChart() {
    const chartContainerRef = useRef<HTMLDivElement>(null)
    const chartRef = useRef<IChartApi | null>(null)
    const { selectedPair } = useTrading()

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
        })

        const candlestickSeries = chart.addSeries(CandlestickSeries, {
            upColor: '#22c55e',
            downColor: '#ef4444',
            borderVisible: false,
            wickUpColor: '#22c55e',
            wickDownColor: '#ef4444',
        })

        // Mock Data Generation based on selectedPair
        // In reality, fetch from API


        const fetchData = async () => {
            try {
                const response = await fetch('https://api.hyperliquid.xyz/info', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: "candleSnapshot",
                        req: {
                            coin: selectedPair,
                            interval: "1h",
                            startTime: Date.now() - 30 * 24 * 60 * 60 * 1000 // Last 30 days
                        }
                    })
                })

                const data = await response.json()
                const candles = data.map((c: any) => ({
                    time: c.t / 1000,
                    open: parseFloat(c.o),
                    high: parseFloat(c.h),
                    low: parseFloat(c.l),
                    close: parseFloat(c.c),
                })).sort((a: any, b: any) => a.time - b.time)

                candlestickSeries.setData(candles)
            } catch (error) {
                console.error("Error fetching candles:", error)
            }
        }

        fetchData()

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
    }, [selectedPair])

    return (
        <Card className="bg-slate-900 border-slate-800 col-span-2">
            <CardHeader>
                <CardTitle className="text-slate-400">{selectedPair} / USD - Technical Analysis</CardTitle>
            </CardHeader>
            <CardContent>
                <div ref={chartContainerRef} className="w-full h-[400px]" />
            </CardContent>
        </Card>
    )
}
