import fs from "fs/promises";
import path from "path";
import { spawnSync } from "child_process";
import { FeatureStore } from "@/src/backtest/FeatureStore";
import { buildMarketFeaturesFromSnapshots, inferSourceFromPath, parseHyperliquidL2File } from "@/src/backtest/L2FeatureBuilder";

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const input = required(args.input, "--input is required");
    const intervalSeconds = Number(args["interval-seconds"] ?? 10);
    const network = (args.network ?? "mainnet") as "mainnet" | "testnet";
    const store = new FeatureStore({ network, dbPath: args.db });

    await maybeDownload(args);
    const files = await collectFiles(input);
    const filesBySymbol = new Map<string, string[]>();
    for (const file of files) {
        if (file.endsWith(".lz4")) {
            const sibling = file.replace(/\.lz4$/, "");
            try {
                await fs.stat(sibling);
            } catch {
                console.warn(`[backtest:features] Skipping compressed file ${file}; decompress first or provide --download-s3 with lz4 installed.`);
            }
            continue;
        }
        const symbol = path.basename(file).replace(/\.jsonl?$/i, "");
        const bucket = filesBySymbol.get(symbol) ?? [];
        bucket.push(file);
        filesBySymbol.set(symbol, bucket);
    }

    let inserted = 0;

    for (const [symbol, symbolFiles] of filesBySymbol) {
        const snapshots = (await Promise.all(
            symbolFiles.sort().map(file => parseHyperliquidL2File(file, symbol))
        )).flat().sort((a, b) => a.ts.getTime() - b.ts.getTime());
        const source = symbolFiles.length === 1
            ? inferSourceFromPath(symbolFiles[0])
            : { sourceDate: inferSourceFromPath(symbolFiles[0]).sourceDate, sourceHour: null, sourceFile: input };
        const rows = buildMarketFeaturesFromSnapshots(snapshots, {
            intervalSeconds,
            sourceDate: source.sourceDate,
            sourceHour: source.sourceHour,
            sourceFile: source.sourceFile
        });
        inserted += await store.upsertRows(rows);
        console.log(`[backtest:features] ${symbol}: parsed ${snapshots.length} from ${symbolFiles.length} file(s), upserted ${rows.length}`);
    }

    await store.close();
    console.log(`[backtest:features] Done. Upserted ${inserted} feature rows.`);
}

async function maybeDownload(args: Record<string, string>) {
    if (!args["download-s3"]) return;
    const s3Prefix = args["download-s3"];
    const input = required(args.input, "--input is required with --download-s3");
    await fs.mkdir(input, { recursive: true });
    const cp = spawnSync("aws", ["s3", "cp", "--recursive", s3Prefix, input], { stdio: "inherit" });
    if (cp.status !== 0) throw new Error(`aws s3 cp failed for ${s3Prefix}`);
    const files = await collectFiles(input);
    for (const file of files.filter(f => f.endsWith(".lz4"))) {
        const out = file.replace(/\.lz4$/, "");
        const lz4 = spawnSync("lz4", ["-d", "-f", file, out], { stdio: "inherit" });
        if (lz4.status !== 0) throw new Error(`lz4 decompression failed for ${file}`);
    }
}

async function collectFiles(input: string): Promise<string[]> {
    const stat = await fs.stat(input);
    if (stat.isFile()) return [input];
    const result: string[] = [];
    const entries = await fs.readdir(input, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(input, entry.name);
        if (entry.isDirectory()) result.push(...await collectFiles(full));
        else result.push(full);
    }
    return result.sort();
}

function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        args[token.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
    return args;
}

function required(value: string | undefined, message: string): string {
    if (!value) throw new Error(message);
    return value;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
