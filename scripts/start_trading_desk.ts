import Module from "module";
// Match the local workers' Next server-only module boundary.
const loader = Module as typeof Module & { _load?: (...args: any[]) => unknown };
const original = loader._load;
if (original)
    loader._load = function (request: string, ...args: any[]) {
        if (request === "server-only") return {};
        return original.call(this, request, ...args);
    };

async function main() {
    const { ensureAppDbReady, prisma } = await import("../lib/db");
    const { TradingDeskWorker } = await import("../services/TradingDeskWorker");
    await ensureAppDbReady();
    const worker = new TradingDeskWorker();
    let stop = false;
    process.once("SIGTERM", () => {
        stop = true;
        void worker.close();
    });
    process.once("SIGINT", () => {
        stop = true;
        void worker.close();
    });
    try {
        try {
            await worker.checkStorage();
        } catch (error) {
            if (!(await worker.stopOnCorruption(error))) throw error;
        }
        while (!stop) {
            try {
                await worker.poll();
            } catch (e) {
                if (!(await worker.stopOnCorruption(e))) console.error("[Trading desk] Poll failed", e instanceof Error ? e.message : "database unavailable");
            }
            if (!stop) await new Promise((r) => setTimeout(r, 5000));
        }
    } finally {
        await worker.close();
        await prisma.$disconnect();
    }
}
main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
