import Link from "next/link";
import { TopHeader } from "@/components/TopHeader";
import { TradingDesk } from "@/components/desk/TradingDesk";
import "./desk.css";
import "./office.css";
import "./chat.css";
import "./controls.css";
import "./records.css";
import "./market-context.css";

export default function DeskPage() {
    return (
        <div className="desk-shell min-h-screen bg-slate-950 text-slate-100">
            <TopHeader />
            <main className="desk-main">
                <div className="desk-page-title">
                    <h1>Trading desk</h1>
                    <Link href="/" className="desk-back">← Trading terminal</Link>
                </div>
                <TradingDesk />
            </main>
        </div>
    );
}
