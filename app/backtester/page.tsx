import { Backtester } from "@/components/Backtester"
import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function BacktesterPage() {
    return (
        <div className="min-h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
            <div className="mx-auto flex min-h-screen max-w-[1920px] flex-col px-4 py-4 md:px-6 md:py-6 gap-4 ml-16">
                {/* Breadcrumb Navigation */}
                <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
                    <Link href="/">
                        <Button variant="ghost" size="sm" className="gap-2 hover:bg-slate-800">
                            <ChevronLeft className="h-4 w-4" />
                            Back to Dashboard
                        </Button>
                    </Link>
                </div>

                {/* Full-width Backtester */}
                <main className="flex-1">
                    <Backtester />
                </main>
            </div>
        </div>
    )
}
