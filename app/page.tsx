import { LeftNavigation } from "@/components/LeftNavigation";
import { TopHeader } from "@/components/TopHeader";
import { HyperliquidFeed } from "@/components/HyperliquidFeed";
import { TechnicalChart } from "@/components/TechnicalChart";
import { ExecutionPanel } from "@/components/ExecutionPanel";
import { PositionsTable } from "@/components/PositionsTable";
import { SentimentPanel } from "@/components/SentimentPanel";
import { AdvancedIndicators } from "@/components/AdvancedIndicators";



export default function Home() {
  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      {/* Left Navigation */}
      <LeftNavigation />

      {/* Top Header */}
      <TopHeader />

      {/* Main Content Area - offset by left nav and top header */}
      <div className="ml-20 mt-16 min-h-[calc(100vh-4rem)]">
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

          {/* Right Action Panel - Fixed width, scrollable */}
          <aside className="w-96 space-y-4 h-[calc(100vh-6rem)] overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-slate-800 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-slate-700 flex flex-col">
            <ExecutionPanel className="flex-1" />


          </aside>
        </div>
      </div>
    </div>
  );
}
