import { signL1Action } from "@nktkas/hyperliquid/signing";
import { OrderRequest, parser } from "@nktkas/hyperliquid/api/exchange";
import { privateKeyToAccount } from "viem/accounts";

type Hex = `0x${string}`;

// Helper to normalize numbers (strip trailing zeros)
function normalizeNumber(x: number): string {
    const s = x.toString();
    if (!s.includes(".")) return s;
    return s.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.$/, "");
}

// Fetch asset metadata (tick size) from Hyperliquid
async function getAssetMeta(asset: number, isTestnet: boolean) {
    const apiUrl = isTestnet
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";

    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "meta" }),
    });

    const data = await res.json();
    return data.universe[asset];
}

// Round price according to Hyperliquid rules:
// 1. Max 5 significant figures
// 2. Max (6 - szDecimals) decimal places for perpetuals
function roundToTickSize(price: number, szDecimals: number): number {
    const MAX_DECIMALS = 6; // For perpetuals
    const MAX_SIG_FIGS = 5;

    // Calculate max decimal places based on szDecimals
    const maxDecimalPlaces = MAX_DECIMALS - szDecimals;

    // Round to max decimal places first
    const factor = Math.pow(10, maxDecimalPlaces);
    let rounded = Math.round(price * factor) / factor;

    // Now enforce 5 significant figures
    // Count significant figures
    const priceStr = rounded.toString().replace('.', '');
    const leadingZeros = priceStr.match(/^0*/)?.[0].length || 0;
    const sigFigs = priceStr.length - leadingZeros;

    if (sigFigs > MAX_SIG_FIGS) {
        // Need to reduce precision
        // Convert to scientific notation, keep 5 sig figs, convert back
        const magnitude = Math.floor(Math.log10(Math.abs(rounded)));
        const scale = Math.pow(10, magnitude - MAX_SIG_FIGS + 1);
        rounded = Math.round(rounded / scale) * scale;
    }

    return rounded;
}

export async function placeOrder(
    privateKey: string,
    order: {
        asset: number;
        isBuy: boolean;
        limitPx: number;
        sz: number;
        reduceOnly: boolean;
    },
    isTestnet = false,
) {
    const nonce = Date.now();

    // Fetch asset metadata to get tick size
    const assetMeta = await getAssetMeta(order.asset, isTestnet);
    console.log("📋 Asset metadata:", assetMeta);
    const szDecimals = assetMeta.szDecimals;

    // Round price to tick size
    const roundedPrice = roundToTickSize(order.limitPx, szDecimals);
    console.log(`📊 Original price: ${order.limitPx}, Rounded to tick size: ${roundedPrice} (${6 - szDecimals} decimals max)`);

    // Raw action in the same shape as the Rust structs
    const rawAction = {
        type: "order" as const,
        orders: [
            {
                a: order.asset,
                b: order.isBuy,
                p: normalizeNumber(roundedPrice), // Use rounded price
                s: normalizeNumber(order.sz),
                r: order.reduceOnly,
                t: { limit: { tif: "Gtc" as const } },
            },
        ],
        grouping: "na" as const,
    };

    // Let the SDK parser handle sorting/formatting for correct msgpack
    const action = parser(OrderRequest.entries.action)(rawAction);

    // Create wallet from private key - no MetaMask needed!
    const wallet = privateKeyToAccount(privateKey as Hex);

    console.log("🔑 Signing with address:", wallet.address);
    console.log("🔑 Private key (first 10 chars):", privateKey.substring(0, 10) + "...");
    console.log("🔑 isTestnet:", isTestnet);

    // SDK handles: correct msgpack, connectionId, EIP-712 domain (Exchange, 1337)
    // No network switching needed - signs directly with private key
    // IMPORTANT: isTestnet changes the 'source' field: "a" for mainnet, "b" for testnet
    const signature = await signL1Action({ wallet, action, nonce, isTestnet });

    const payload = { action, nonce, signature };

    console.log("📤 Sending payload to Hyperliquid:");
    console.log(JSON.stringify(payload, null, 2));

    const apiUrl = isTestnet
        ? "https://api.hyperliquid-testnet.xyz/exchange"
        : "https://api.hyperliquid.xyz/exchange";

    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API Error: ${text}`);
    }

    return res.json();
}
