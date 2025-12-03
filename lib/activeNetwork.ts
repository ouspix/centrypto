export type ActiveNetwork = "testnet" | "mainnet";

function resolveActiveNetwork(): ActiveNetwork {
    const raw = (process.env.ACTIVE_NETWORK || process.env.NEXT_PUBLIC_ACTIVE_NETWORK || "testnet").toLowerCase();
    return raw === "mainnet" ? "mainnet" : "testnet";
}

export function getActiveNetwork(): ActiveNetwork {
    return resolveActiveNetwork();
}

export function isActiveTestnet(): boolean {
    return getActiveNetwork() === "testnet";
}
