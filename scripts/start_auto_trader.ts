import Module from "module";

const cjsModule = Module as typeof Module & { _load?: (...args: any[]) => unknown };
const originalLoad = cjsModule._load;
if (originalLoad) {
    cjsModule._load = function patchedLoad(request: string, ...args: any[]) {
        if (request === "server-only") return {};
        return originalLoad.call(this, request, ...args);
    };
}

void main();

async function main() {
    const { AutoTraderService } = await import("../services/AutoTraderService");

    const service = AutoTraderService.getInstance();
    await service.bootstrapEnabled();
    await service.runDueOnce();

    console.log("[AutoTrader] Worker started. Polling persisted auto-trader settings.");

    const interval = setInterval(() => {
        service.runDueOnce().catch(error => {
            console.error("[AutoTrader] Poll failed:", error);
        });
    }, 30_000);

    const shutdown = () => {
        clearInterval(interval);
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
