import fs from 'fs';
import path from 'path';
import { getMetaAndAssetCtxs } from '../lib/hyperliquid-info';

async function updateSymbols() {
    console.log("🚀 Starting symbol update...");

    // 1. Fetch Universe from Hyperliquid (Mainnet has the most complete list)
    console.log("📡 Fetching universe from Hyperliquid Mainnet...");
    const meta = await getMetaAndAssetCtxs(false); // false = mainnet

    if (!meta || !meta.universe) {
        console.error("❌ Failed to fetch universe.");
        process.exit(1);
    }

    const universe = meta.universe;
    console.log(`✅ Found ${universe.length} assets in universe.`);

    // 2. Read existing symbols.json
    const configPath = path.join(process.cwd(), 'config', 'symbols.json');
    let symbolsConfig: Record<string, string[]> = {};

    if (fs.existsSync(configPath)) {
        console.log("📖 Reading existing symbols.json...");
        const raw = fs.readFileSync(configPath, 'utf-8');
        symbolsConfig = JSON.parse(raw);
    } else {
        console.log("⚠️ symbols.json not found, creating new one.");
    }

    // 3. Update Config
    let addedCount = 0;
    let updatedCount = 0;

    for (const asset of universe) {
        const symbol = asset.name;

        if (!symbolsConfig[symbol]) {
            // New symbol
            symbolsConfig[symbol] = [
                symbol,
                symbol.toLowerCase()
            ];
            addedCount++;
        } else {
            // Existing symbol - ensure basic keywords exist
            const keywords = new Set(symbolsConfig[symbol]);
            if (!keywords.has(symbol)) {
                keywords.add(symbol);
                updatedCount++;
            }
            if (!keywords.has(symbol.toLowerCase())) {
                keywords.add(symbol.toLowerCase());
                updatedCount++;
            }
            symbolsConfig[symbol] = Array.from(keywords);
        }
    }

    // 4. Write back to file
    console.log(`💾 Writing updates to symbols.json (Added: ${addedCount}, Updated: ${updatedCount})...`);
    fs.writeFileSync(configPath, JSON.stringify(symbolsConfig, null, 2));
    console.log("✅ Done!");
}

updateSymbols().catch(console.error);
