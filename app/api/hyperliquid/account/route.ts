import { NextResponse } from "next/server";
import { getWalletSessionFromRequest, normalizeWalletAddress, WalletSessionError } from "@/lib/auth/wallet-session";
import { getAllMids, getClearinghouseState, getSpotClearinghouseState } from "@/lib/hyperliquid-info";

export const dynamic = "force-dynamic";

type OpenPosition = {
    coin: string;
    size: number;
    entryPx: number;
    leverage: number;
};

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const session = getWalletSessionFromRequest(request);
        const requestedAddress = searchParams.get("address");
        const userAddress = requestedAddress
            ? normalizeWalletAddress(requestedAddress)
            : session?.address;
        if (!userAddress) {
            return NextResponse.json({ error: "Wallet address required" }, { status: 400 });
        }

        const isTestnet = parseIsTestnet(searchParams);
        const [state, spotState] = await Promise.all([
            getClearinghouseState(userAddress, isTestnet),
            getSpotClearinghouseState(userAddress, isTestnet)
        ]);

        if (state?.marginSummary?.accountValue === undefined || state?.marginSummary?.accountValue === null) {
            return NextResponse.json({ error: "Hyperliquid account state unavailable" }, { status: 502 });
        }

        const marginSummary = state.marginSummary;
        const perpAccountValue = numberFrom(marginSummary.accountValue);
        const assetPositions = Array.isArray(state.assetPositions) ? state.assetPositions : [];
        const spotUsdc = readSpotUsdc(spotState);
        const useSpotEquity = shouldUseSpotEquity(perpAccountValue, spotUsdc, spotState);
        const accountValue = useSpotEquity ? spotUsdc : perpAccountValue;
        const equitySource = useSpotEquity
            ? "spot_usdc"
            : "perps";
        const unrealizedPnl = assetPositions.reduce((sum: number, pos: any) => {
            return sum + numberFrom(pos?.position?.unrealizedPnl);
        }, 0);

        const openPositions: OpenPosition[] = assetPositions
            .filter((pos: any) => numberFrom(pos?.position?.szi) !== 0)
            .map((pos: any) => ({
                coin: String(pos?.position?.coin ?? ""),
                size: numberFrom(pos?.position?.szi),
                entryPx: numberFrom(pos?.position?.entryPx),
                leverage: numberFrom(pos?.position?.leverage?.value) || 1
            }))
            .filter((pos: OpenPosition) => pos.coin && Number.isFinite(pos.size));

        const mids = openPositions.length > 0 ? await getAllMids(isTestnet) : {};
        const totals = openPositions.reduce((acc, position) => {
            const mid = numberFrom(mids[position.coin]);
            const price = mid > 0 ? mid : position.entryPx;
            if (!Number.isFinite(price) || price <= 0) return acc;

            const exposureUsd = Math.abs(position.size) * price;
            const leverage = Number.isFinite(position.leverage) && position.leverage > 0 ? position.leverage : 1;
            acc.exposureUsd += exposureUsd;
            acc.marginUsd += exposureUsd / leverage;
            return acc;
        }, { exposureUsd: 0, marginUsd: 0 });

        return NextResponse.json({
            address: userAddress,
            network: isTestnet ? "testnet" : "mainnet",
            accountValue,
            perpAccountValue,
            spotUsdc,
            equitySource,
            unrealizedPnl,
            totalExposurePct: accountValue > 0 ? (totals.exposureUsd / accountValue) * 100 : 0,
            marginUsagePct: accountValue > 0 ? (totals.marginUsd / accountValue) * 100 : 0,
            positionCount: openPositions.length
        });
    } catch (error) {
        const status = error instanceof WalletSessionError ? error.status : 500;
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to fetch Hyperliquid account state"
        }, { status });
    }
}

function parseIsTestnet(searchParams: URLSearchParams): boolean {
    const network = searchParams.get("network");
    if (network) return network !== "mainnet";
    return searchParams.get("isTestnet") === "true";
}

function numberFrom(value: unknown): number {
    const parsed = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
    return Number.isFinite(parsed) ? parsed : 0;
}

function readSpotUsdc(spotState: any): number {
    const balances = Array.isArray(spotState?.balances) ? spotState.balances : [];
    const usdc = balances.find((balance: any) => String(balance?.coin ?? "").toUpperCase() === "USDC");
    return numberFrom(usdc?.total);
}

function shouldUseSpotEquity(perpAccountValue: number, spotUsdc: number, spotState: any): boolean {
    if (spotUsdc <= 0) return false;
    if (perpAccountValue <= 0) return true;
    return Array.isArray(spotState?.tokenToAvailableAfterMaintenance);
}
