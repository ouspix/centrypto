import { startCollectorWorker } from "@/services/CollectorRunner";

console.log("Starting Market Data Collector...");
console.log("Starting testnet and mainnet collectors with startup backfill.");

startCollectorWorker(true);
startCollectorWorker(false);

process.on("SIGINT", () => {
    console.log("Stopping collector...");
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("Stopping collector...");
    process.exit(0);
});
