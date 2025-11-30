import { LeftNavigation } from "@/components/LeftNavigation";
import { TopHeader } from "@/components/TopHeader";
import { HyperliquidFeed } from "@/components/HyperliquidFeed";
import { TechnicalChart } from "@/components/TechnicalChart";
import { TradingAndRisk } from "@/components/TradingAndRisk";
import { PositionsTable } from "@/components/PositionsTable";
import { SentimentPanel } from "@/components/SentimentPanel";
import { AdvancedIndicators } from "@/components/AdvancedIndicators";



export default function Home() {
  return (
    <div className="min-h-screen w-full text-slate-100">
      {/* Left Navigation */}
      <LeftNavigation />

      {/* Top Header */}
      <TopHeader />

      {/* Main Content Area - offset by left nav and top header */}
      <div className="ml-20 mt-16 min-h-[calc(100vh-4rem)] mr-[400px]">
        <div className="flex gap-4 p-4 md:p-6">
          {/* Center Workspace */}
          <div className="flex-1 space-y-4">
            {/* Chart Area - Takes 60% of vertical space */}
            <div className="h-[60vh]">
              <TechnicalChart />
            </div>

            {/* Market Feed & Data */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <HyperliquidFeed />
              <SentimentPanel />
            </div>

            {/* Bottom Data Table - Positions */}
            <PositionsTable />
          </div>

          {/* Right Action Panel - Fixed width, 30% larger */}
          <aside className="fixed right-0 top-16 bottom-0 w-[400px] flex flex-col overflow-hidden border-l border-slate-800 bg-slate-950 z-50">
            <TradingAndRisk className="h-full" />
          </aside>
        </div>
      </div>
    </div>
  );
}
