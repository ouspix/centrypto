import { HyperliquidFeed } from "@/components/HyperliquidFeed";
import { Dashboard } from "@/components/Dashboard";
import { SentimentPanel } from "@/components/SentimentPanel";
import { TradeForm } from "@/components/TradeForm";
import { TechnicalChart } from "@/components/TechnicalChart";
import { AIAdvisor } from "@/components/AIAdvisor";
import { OpenPositions } from "@/components/OpenPositions";
import { Backtester } from "@/components/Backtester";
import { WalletConnect } from "@/components/WalletConnect";
import { ScreeningParameters } from "@/components/ScreeningParameters";
import { AdvancedIndicators } from "@/components/AdvancedIndicators";
import { PriceAlerts } from "@/components/PriceAlerts";
import { TradeHistory } from "@/components/TradeHistory";

export default function Home() {
  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1920px] flex-col px-4 py-4 md:px-6 md:py-6 gap-4">
        {/* Header */}
        <header className="flex items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2 shadow-lg">
              <span className="font-mono text-lg font-bold bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                Centrypto
              </span>
            </div>
          </div>
          <WalletConnect />
        </header>

        {/* Main content */}
        <main className="flex-1">
          <section className="grid auto-rows-min grid-cols-1 gap-5 lg:grid-cols-12">
            {/* ROW 1 */}
            {/* Left Column: Screening + Market feed */}
            <div className="space-y-5 lg:col-span-4">
              <ScreeningParameters />
              <HyperliquidFeed />
            </div>

            {/* Technical chart */}
            <div className="lg:col-span-5">
              <TechnicalChart />
            </div>

            {/* AI trader agent */}
            <div className="lg:col-span-3">
              <AIAdvisor />
            </div>

            {/* ROW 2 */}
            {/* Advanced Indicators */}
            <div className="lg:col-span-4">
              <AdvancedIndicators />
            </div>

            {/* Sentiment */}
            <div className="lg:col-span-5">
              <SentimentPanel />
            </div>

            {/* Price Alerts */}
            <div className="lg:col-span-3">
              <PriceAlerts />
            </div>

            {/* ROW 3 */}
            {/* Account + trade tools */}
            <div className="space-y-5 lg:col-span-5">
              <Dashboard />
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <TradeForm />
                <Backtester />
              </div>
            </div>

            {/* Portfolio / open positions */}
            <div className="lg:col-span-4">
              <OpenPositions />
            </div>

            {/* Trade History */}
            <div className="lg:col-span-3">
              <TradeHistory />
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
