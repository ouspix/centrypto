import { HyperliquidFeed } from "@/components/HyperliquidFeed";
import { Dashboard } from "@/components/Dashboard";
import { SentimentPanel } from "@/components/SentimentPanel";
import { TradeForm } from "@/components/TradeForm";
import { TechnicalChart } from "@/components/TechnicalChart";
import { AIAdvisor } from "@/components/AIAdvisor";

import { WalletConnect } from "@/components/WalletConnect";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-24 bg-slate-950">
      <div className="z-10 max-w-6xl w-full items-center justify-between font-mono text-sm lg:flex mb-8">
        <p className="fixed left-0 top-0 flex w-full justify-center border-b border-gray-300 bg-gradient-to-b from-zinc-200 pb-6 pt-8 backdrop-blur-2xl dark:border-neutral-800 dark:bg-zinc-800/30 dark:from-inherit lg:static lg:w-auto  lg:rounded-xl lg:border lg:bg-gray-200 lg:p-4 lg:dark:bg-zinc-800/30">
          <code className="font-mono font-bold">Centrypto</code>
        </p>
        <div className="fixed bottom-0 left-0 flex h-48 w-full items-end justify-center bg-gradient-to-t from-white via-white dark:from-black dark:via-black lg:static lg:h-auto lg:w-auto lg:bg-none">
          <WalletConnect />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 w-full max-w-[1600px]">
        <div className="col-span-1 lg:col-span-1 space-y-6">
          <HyperliquidFeed />
          <SentimentPanel />
        </div>

        <div className="col-span-1 lg:col-span-2 space-y-6">
          <div className="grid grid-cols-1 gap-6">
            <TechnicalChart />
            <Dashboard />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <TradeForm />
            <div className="border border-slate-800 rounded-xl p-6 bg-slate-900/50 h-full">
              <h2 className="text-xl font-bold mb-4 text-blue-400">Orchestrator Log</h2>
              <div className="text-slate-500 text-sm font-mono">
                [10:42:15] System initialized<br />
                [10:42:16] Connected to Hyperliquid<br />
                [10:42:18] AI Advisor active
              </div>
            </div>
          </div>
        </div>

        <div className="col-span-1 lg:col-span-1 space-y-6">
          <AIAdvisor />
        </div>
      </div>
    </main>
  );
}
