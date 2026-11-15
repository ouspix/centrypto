"use client";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TradeForm } from "@/components/TradeForm";
import { HyperliquidApiWalletSettings } from "@/components/HyperliquidApiWalletSettings";
import { useTrading } from "@/context/TradingContext";
export function TradingAndRisk({ className }: { className?: string }) {
  const { isTestnet, walletSessionAddress } = useTrading();
  return (
    <Card
      className={`border-slate-700 bg-slate-950 flex flex-col overflow-hidden ${className ?? ""}`}
    >
      <CardHeader className="space-y-3">
        <CardTitle>Manual trading</CardTitle>
        <HyperliquidApiWalletSettings
          isTestnet={isTestnet}
          walletSessionAddress={walletSessionAddress}
        />
        <Link href="/desk" className="text-cyan-300">
          Open the autonomous desk →
        </Link>
        <p className="text-xs text-slate-400">
          New manual trades are blocked while the desk manages this account.
          Manual closes and cancellations pause its authority and require
          reconciliation before resuming.
        </p>
      </CardHeader>
      <CardContent className="overflow-y-auto">
        <TradeForm />
      </CardContent>
    </Card>
  );
}
