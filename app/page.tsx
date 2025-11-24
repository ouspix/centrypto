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
          <div className="flex flex-col lg:flex-row gap-5">
            {/* LEFT COLUMN: Main Content (Screening, Charts, etc.) */}
            <div className="w-full lg:w-3/4">
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-9">
                {/* ROW 1 */}
                <div className="space-y-5 lg:col-span-4">
                  <ScreeningParameters />
                  <HyperliquidFeed />
                </div>
                <div className="lg:col-span-5">
                  <TechnicalChart />
                </div>

                {/* ROW 2 */}
                <div className="lg:col-span-4">
                  <AdvancedIndicators />
                </div>
                <div className="lg:col-span-5">
                  <SentimentPanel />
                </div>

                {/* ROW 3 */}
                <div className="space-y-5 lg:col-span-5">
                  <Dashboard />
                  <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <TradeForm />
                    <Backtester />
                  </div>
                </div>
                <div className="lg:col-span-4">
                  <OpenPositions />
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: Sticky Sidebar (AI, Alerts, History) */}
            <div className="w-full lg:w-1/4">
              <div className="sticky top-4 flex flex-col gap-5 h-[calc(100vh-2rem)] overflow-y-auto pr-1 pb-4 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
                <AIAdvisor />
                <PriceAlerts />
                <TradeHistory />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
