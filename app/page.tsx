import { HyperliquidFeed } from "@/components/HyperliquidFeed";
import { Dashboard } from "@/components/Dashboard";
import { SentimentPanel } from "@/components/SentimentPanel";
import { TradeForm } from "@/components/TradeForm";
import { TechnicalChart } from "@/components/TechnicalChart";
import { AIAdvisor } from "@/components/AIAdvisor";
import { OpenPositions } from "@/components/OpenPositions";
import { Backtester } from "@/components/Backtester";

import { WalletConnect } from "@/components/WalletConnect";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-6 md:p-12 lg:p-24 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <div className="z-10 max-w-7xl w-full items-center justify-between font-mono text-sm lg:flex mb-8">
        <div className="fixed left-0 top-0 flex w-full justify-center border-b border-slate-800 bg-slate-950/80 backdrop-blur-xl pb-6 pt-8 lg:static lg:w-auto lg:rounded-xl lg:border lg:bg-slate-900/50 lg:p-4 shadow-lg">
          <code className="font-mono font-bold text-xl bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
            Centrypto
          </code>
        </div>
        <div className="fixed bottom-0 left-0 flex h-48 w-full items-end justify-center bg-gradient-to-t from-slate-950 via-slate-950 lg:static lg:h-auto lg:w-auto lg:bg-none">
          <WalletConnect />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full max-w-[1800px]">
        {/* Left Column - Market Data */}
        <div className="col-span-1 lg:col-span-3 space-y-6">
          <HyperliquidFeed />
          <SentimentPanel />
        </div>

        {/* Center Column - Charts & Trading */}
        <div className="col-span-1 lg:col-span-6 space-y-6">
          <TechnicalChart />
          <Dashboard />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <TradeForm />
            <Backtester />
          </div>
          <OpenPositions />
        </div>

        {/* Right Column - AI & Analysis */}
        <div className="col-span-1 lg:col-span-3 space-y-6">
          <AIAdvisor />
        </div>
      </div>
    </main>
  );
}
