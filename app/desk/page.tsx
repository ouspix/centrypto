import Link from "next/link";
import { TopHeader } from "@/components/TopHeader";
import { TradingDesk } from "@/components/desk/TradingDesk";
import "./desk.css";

export default function DeskPage() {
    return (
        <div className="desk-shell min-h-screen bg-slate-950 text-slate-100">
            <TopHeader />
            <main className="desk-main">
                <Link href="/" className="desk-back">
                    ← Trading terminal
                </Link>
                <div className="desk-heading">
                    <small>CENTRYPTO · OPERATIONS</small>
                    <h1>Trading desk</h1>
                </div>
                <TradingDesk />
            </main>
        </div>
    );
}
