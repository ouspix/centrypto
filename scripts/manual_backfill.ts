import { MarketCollectorService } from "@/services/MarketCollectorService";
import { marketDbMain, marketDbTest } from "@/lib/market-db";

const collector = new MarketCollectorService();

async function runBackfill() {
    const args = parseArgs(process.argv.slice(2));
    const networks = resolveNetworks(args.network);
    const force = args.force !== "false";

    console.log(`🚀 Starting Manual Backfill for ${networks.map(n => n.label).join(", ")} (force=${force})...`);
    const start = Date.now();

    for (const network of networks) {
        await collector.backfillHistory(network.isTestnet, force);
    }

    const duration = (Date.now() - start) / 1000;
    console.log(`✅ Manual Backfill complete in ${duration}s.`);
}

function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const key = token.slice(2);
        args[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
    return args;
}

function resolveNetworks(network = "both") {
    if (network === "mainnet" || network === "main") return [{ isTestnet: false, label: "Mainnet" }];
    if (network === "testnet" || network === "test") return [{ isTestnet: true, label: "Testnet" }];
    if (network === "both") {
        return [
            { isTestnet: true, label: "Testnet" },
            { isTestnet: false, label: "Mainnet" }
        ];
    }
    throw new Error(`Unsupported --network ${network}. Use mainnet, testnet, or both.`);
}

runBackfill()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await marketDbMain.$disconnect();
        await marketDbTest.$disconnect();
    });
