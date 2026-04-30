"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TradeForm } from "@/components/TradeForm"
import { AIAdvisor } from "@/components/AIAdvisor"
import { LlmDecisionsLog } from "@/components/LlmDecisionsLog"
import { HyperliquidApiWalletSettings } from "@/components/HyperliquidApiWalletSettings"
import { useTrading } from "@/context/TradingContext"
import { Zap, BrainCircuit, ScrollText } from "lucide-react"

export function TradingAndRisk({ className }: { className?: string }) {
    const [activeTab, setActiveTab] = useState<string>("manual")
    const { isTestnet, walletSessionAddress } = useTrading()

    return (
        <Card className={`bg-gradient-to-br from-slate-900 to-slate-800 border-slate-700 flex flex-col h-full overflow-hidden ${className}`}>
            <CardHeader className="pb-3 flex-none space-y-3">
                <CardTitle className="text-lg font-semibold text-slate-100">
                    Trading & Risk
                </CardTitle>
                <HyperliquidApiWalletSettings isTestnet={isTestnet} walletSessionAddress={walletSessionAddress} />
            </CardHeader>
            <CardContent className="p-0 flex-1 flex flex-col min-h-0 overflow-hidden">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full flex flex-col flex-1 h-full">
                    <TabsList className="grid w-full grid-cols-3 bg-transparent border-b border-slate-800 h-auto p-0 rounded-none flex-none">
                        <TabsTrigger
                            value="manual"
                            className="data-[state=active]:border-b-2 data-[state=active]:border-blue-500 data-[state=active]:text-blue-400 data-[state=active]:bg-transparent rounded-none border-b-2 border-transparent pb-3 text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-2"
                        >
                            <Zap className="h-4 w-4" />
                            Manual
                        </TabsTrigger>
                        <TabsTrigger
                            value="ai"
                            className="data-[state=active]:border-b-2 data-[state=active]:border-purple-500 data-[state=active]:text-purple-400 data-[state=active]:bg-transparent rounded-none border-b-2 border-transparent pb-3 text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-2"
                        >
                            <BrainCircuit className="h-4 w-4" />
                            AI Agent
                        </TabsTrigger>
                        <TabsTrigger
                            value="log"
                            className="data-[state=active]:border-b-2 data-[state=active]:border-emerald-500 data-[state=active]:text-emerald-400 data-[state=active]:bg-transparent rounded-none border-b-2 border-transparent pb-3 text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-2"
                        >
                            <ScrollText className="h-4 w-4" />
                            Log
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="manual" className="mt-0 flex-1 min-h-0 overflow-y-auto p-4 data-[state=inactive]:hidden data-[state=active]:flex flex-col">
                        <TradeForm />
                    </TabsContent>

                    <TabsContent
                        value="ai"
                        forceMount
                        className="mt-0 flex-1 min-h-0 overflow-hidden data-[state=inactive]:hidden data-[state=active]:flex flex-col"
                    >
                        <AIAdvisor />
                    </TabsContent>

                    <TabsContent value="log" className="mt-0 flex-1 min-h-0 overflow-hidden data-[state=inactive]:hidden data-[state=active]:flex flex-col">
                        <LlmDecisionsLog className="h-full p-4" />
                    </TabsContent>
                </Tabs>
            </CardContent>
        </Card>
    )
}
