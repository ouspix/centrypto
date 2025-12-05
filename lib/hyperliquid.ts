import { signL1Action } from "@nktkas/hyperliquid/signing";
import { OrderRequest, CancelRequest, parser } from "@nktkas/hyperliquid/api/exchange";
import { privateKeyToAccount } from "viem/accounts";

type Hex = `0x${string} `;

// Fetch asset metadata (tick size) from Hyperliquid
export type AssetMeta = {
    name: string;
    szDecimals: number;
    maxLeverage: number;
    onlyIsolated: boolean;
    isPerp: boolean;
    minSz: number; // Added minSz
}

export async function getMeta(isTestnet: boolean): Promise<AssetMeta[]> {
    const apiUrl = isTestnet
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";

    try {
        await waitForHyperliquidSlot();
        const res = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "meta" }),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch metadata: ${res.statusText} `);
        }

        const data = await res.json();
        return data.universe;
    } catch (error) {
        console.error("Error fetching metadata:", error);
        return [];
    }
}

// Helper to get single asset meta (deprecated in favor of bulk fetch, but kept for compatibility if needed)
async function getAssetMeta(asset: number, isTestnet: boolean) {
    const universe = await getMeta(isTestnet);
    return universe[asset];
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

    // Clean up floating point errors by converting to fixed decimal and back
    // This eliminates issues like 2721.7000000000003 -> 2721.7
    return parseFloat(rounded.toFixed(maxDecimalPlaces));
}

export type PlaceOrderRequest = {
    asset: number;
    isBuy: boolean;
    limitPx: number;
    sz: number;
    reduceOnly: boolean;
    stopLossPrice?: number;
    takeProfitPrice?: number;
};

export async function placeOrder(
    privateKey: string,
    order: PlaceOrderRequest,
    isTestnet = false,
) {
    const nonce = Date.now();

    // Fetch asset metadata to get tick size
    const assetMeta = await getAssetMeta(order.asset, isTestnet);
    // console.log("📋 Asset metadata:", assetMeta);
    const szDecimals = assetMeta.szDecimals;
    const priceDecimals = 6 - szDecimals; // Max decimal places for price

    // Round price to tick size
    const roundedPrice = roundToTickSize(order.limitPx, szDecimals);
    // Also round size to avoid floating point errors
    const roundedSize = parseFloat(order.sz.toFixed(szDecimals));

    // Convert to strings with proper decimal places (Hyperliquid requires strings)
    const priceStr = roundedPrice.toFixed(priceDecimals);
    const sizeStr = roundedSize.toFixed(szDecimals);

    console.log(`📊 Original price: ${order.limitPx}, Rounded: ${roundedPrice}, String: "${priceStr}"`);
    console.log(`📊 Original size: ${order.sz}, Rounded: ${roundedSize}, String: "${sizeStr}"`);

    // Enforce venue min notional after rounding to avoid exchange rejects
    const notional = roundedPrice * roundedSize;
    const minNotionalUsd = 10; // Hyperliquid venue minimum for opening/adding
    if (!order.reduceOnly && notional < minNotionalUsd) {
        throw new Error(`Order notional ${notional.toFixed(4)} is below venue minimum $${minNotionalUsd}. size=${sizeStr}, price=${priceStr}`);
    }

    // Hyperliquid API requires p and s to be strings
    const orders: any[] = [
        {
            a: order.asset,
            b: order.isBuy,
            p: priceStr, // Must be string
            s: sizeStr, // Must be string
            r: order.reduceOnly,
            t: { limit: { tif: "Gtc" as const } },
        },
    ];

    // Attach TP/SL as trigger orders if provided
    const pushTriggerOrder = (px: number, type: "tp" | "sl") => {
        const rounded = roundToTickSize(px, szDecimals);
        const triggerPxStr = rounded.toFixed(priceDecimals);
        orders.push({
            a: order.asset,
            b: order.isBuy ? false : true, // Close in the opposite direction
            // Mirror triggerPx as the order price to satisfy validation
            p: triggerPxStr,
            s: sizeStr,
            r: true, // Ensure these never increase exposure
            t: {
                trigger: {
                    isMarket: true,
                    triggerPx: triggerPxStr,
                    tpsl: type
                }
            }
        });
    };

    if (order.stopLossPrice) {
        pushTriggerOrder(order.stopLossPrice, "sl");
    }

    if (order.takeProfitPrice) {
        pushTriggerOrder(order.takeProfitPrice, "tp");
    }

    const rawAction = {
        type: "order" as const,
        orders,
        // normalTpsl is the parent-linked OCO bundle (entry + TP/SL)
        grouping: (order.stopLossPrice || order.takeProfitPrice) ? "normalTpsl" as const : "na" as const,
    };

    // Use SDK parser to ensure proper formatting
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
    console.log("Action:", JSON.stringify(action, null, 2));
    console.log("Full payload:", JSON.stringify(payload, null, 2));

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
        console.error(`❌ API Error(${res.status}): `, text);
        throw new Error(`API Error: ${text}`);
    }

    const data = await res.json();

    // Check if the response indicates an error
    if (data.status === "err") {
        console.error("❌ Order rejected by Hyperliquid:", data.response);
        throw new Error(`Order rejected: ${data.response}`);
    }

    console.log("✅ API Response:", JSON.stringify(data, null, 2));
    return data;
}

export async function cancelOrder(
    privateKey: string,
    cancelRequest: {
        asset: number;
        oid: number;
    },
    isTestnet = false,
) {
    const nonce = Date.now();

    const rawAction = {
        type: "cancel" as const,
        cancels: [
            {
                a: cancelRequest.asset,
                o: cancelRequest.oid,
            },
        ],
        grouping: "na" as const,
    };

    // Use SDK parser to ensure proper formatting
    const action = parser(CancelRequest.entries.action)(rawAction);
    const wallet = privateKeyToAccount(privateKey as Hex);

    console.log("🚫 Cancelling order:", cancelRequest.oid);

    const signature = await signL1Action({ wallet, action, nonce, isTestnet });
    const payload = { action, nonce, signature };

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
        throw new Error(`API Error: ${text} `);
    }

    return res.json();
}

export async function getClearinghouseState(userAddress: string, isTestnet: boolean = false) {
    const apiUrl = isTestnet
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";

    try {
        await waitForHyperliquidSlot();
        const res = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                type: "clearinghouseState",
                user: userAddress
            }),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch clearinghouse state: ${res.statusText} `);
        }

        return await res.json();
    } catch (error) {
        console.error("Error fetching clearinghouse state:", error);
        return null;
    }
}

export type MetaAndAssetCtxs = {
    universe: any[];
    assetCtxs: any[];
};

export async function getMetaAndAssetCtxs(isTestnet: boolean = false): Promise<MetaAndAssetCtxs | null> {
    const apiUrl = isTestnet
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            await waitForHyperliquidSlot(); // Wait for rate limiter

            const res = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "metaAndAssetCtxs" }),
            });

            if (res.status === 429) {
                const waitTime = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
                console.warn(`[Hyperliquid] Rate limited(429) for metaAndAssetCtxs. Retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                attempt++;
                continue;
            }

            if (!res.ok) {
                throw new Error(`Failed to fetch meta and asset contexts: ${res.statusText} `);
            }

            const data = await res.json();

            let universe: any[] | undefined;
            let assetCtxs: any[] | undefined;

            if (Array.isArray(data)) {
                // Newer API shape: [ { universe, marginTables, collateralToken }, assetCtxs ]
                if (data.length >= 2 && data[0]?.universe && Array.isArray(data[1])) {
                    universe = data[0].universe;
                    assetCtxs = data[1];
                }
                // Legacy shape: [ universeArray, assetCtxsArray ]
                else if (data.length >= 2 && Array.isArray(data[0]) && Array.isArray(data[1])) {
                    universe = data[0];
                    assetCtxs = data[1];
                }
            } else if (data?.universe && data?.assetCtxs) {
                // Alt shape: { universe, assetCtxs }
                universe = data.universe;
                assetCtxs = data.assetCtxs;
            }

            if (!universe || !assetCtxs) {
                console.error("Unexpected metaAndAssetCtxs response shape:", data);
                return null;
            }

            return { universe, assetCtxs };
        } catch (error: any) {
            console.error(`Error fetching meta and asset contexts (attempt ${attempt + 1}/${maxRetries}):`, error.message);
            if (attempt === maxRetries - 1) return null;
            attempt++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return null;
}

// Rate Limiter to prevent 429s
const HL_MIN_DELAY_MS = parseInt(process.env.HL_INFO_MIN_DELAY_MS || "900", 10);

class RateLimiter {
    private queue: Array<() => void> = [];
    private processing = false;
    private lastRequestTime = 0;
    private minDelay: number;

    constructor(minDelay: number = HL_MIN_DELAY_MS) {
        this.minDelay = minDelay;
    }

    async wait(): Promise<void> {
        return new Promise((resolve) => {
            this.queue.push(resolve);
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const now = Date.now();
            const timeSinceLast = now - this.lastRequestTime;

            if (timeSinceLast < this.minDelay) {
                await new Promise(r => setTimeout(r, this.minDelay - timeSinceLast));
            }

            const resolve = this.queue.shift();
            if (resolve) {
                this.lastRequestTime = Date.now();
                resolve();
            }
        }

        this.processing = false;
    }
}

const hyperliquidLimiter = new RateLimiter();

export async function waitForHyperliquidSlot(): Promise<void> {
    await hyperliquidLimiter.wait();
}

export async function getOHLCV(coin: string, interval: string, isTestnet: boolean = false, startTime?: number) {
    const apiUrl = isTestnet
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";

    const maxRetries = 3;
    let attempt = 0;

    while (true) {
        try {
            await waitForHyperliquidSlot(); // Wait for rate limiter

            // Get candles for the last 24 hours (approx) to calculate returns
            // Hyperliquid candleSnapshot returns the last N candles
            const start = startTime || (Date.now() - (1000 * 60 * 60 * 24));

            const res = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: "candleSnapshot",
                    req: {
                        coin: coin,
                        interval: interval,
                        startTime: start
                    }
                }),
            });

            if (res.status === 429) {
                const waitTime = Math.min(Math.pow(2, attempt) * 1000, 30000); // Cap at 30s
                console.warn(`[Hyperliquid] Rate limited(429) for ${coin}. Retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                attempt++;
                continue;
            }

            if (!res.ok) {
                throw new Error(`Failed to fetch OHLCV: ${res.statusText} `);
            }

            return await res.json();
        } catch (error: any) {
            console.error(`Error fetching OHLCV(attempt ${attempt + 1}): `, error.message);
            if (attempt >= maxRetries) return []; // Only give up on non-429 errors after maxRetries
            attempt++;
            await new Promise(resolve => setTimeout(resolve, 1000)); // Basic wait for other errors
        }
    }
    return [];
}

export async function getL2Book(coin: string, isTestnet: boolean = false) {
    const apiUrl = isTestnet
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            await waitForHyperliquidSlot(); // Wait for rate limiter

            const res = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: "l2Book",
                    coin: coin
                }),
            });

            if (res.status === 429) {
                const waitTime = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
                console.warn(`[Hyperliquid] Rate limited(429) for L2Book ${coin}. Retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                attempt++;
                continue;
            }

            if (!res.ok) {
                throw new Error(`Failed to fetch L2 Book: ${res.statusText} `);
            }

            return await res.json();
        } catch (error: any) {
            console.error(`Error fetching L2 Book (attempt ${attempt + 1}/${maxRetries}):`, error.message);
            if (attempt === maxRetries - 1) return null;
            attempt++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return null;
}

export async function getUserFills(userAddress: string, isTestnet: boolean = false) {
    const apiUrl = isTestnet
        ? "https://api.hyperliquid-testnet.xyz/info"
        : "https://api.hyperliquid.xyz/info";

    try {
        await waitForHyperliquidSlot();

        const res = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                type: "userFills",
                user: userAddress
            }),
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch user fills: ${res.statusText}`);
        }

        return await res.json();
    } catch (error) {
        console.error("Error fetching user fills:", error);
        return [];
    }
}
