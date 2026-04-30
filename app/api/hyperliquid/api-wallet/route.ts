import { NextRequest, NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import {
    deleteHyperliquidApiWallet,
    getHyperliquidApiWalletStatus,
    HyperliquidApiWalletError,
    registerHyperliquidApiWallet
} from "@/lib/hyperliquid-api-wallet";

export async function GET(request: NextRequest) {
    try {
        const session = requireWalletSession(request);
        const isTestnet = request.nextUrl.searchParams.get("network") !== "mainnet";
        const status = await getHyperliquidApiWalletStatus(session.address, isTestnet);
        return NextResponse.json(status);
    } catch (error) {
        return apiWalletErrorResponse(error, "Failed to read Hyperliquid API wallet status");
    }
}

export async function POST(request: NextRequest) {
    try {
        if (!isSecureRegistrationRequest(request)) {
            return NextResponse.json({ error: "Hyperliquid API wallet registration requires HTTPS in production" }, { status: 400 });
        }
        const session = requireWalletSession(request);
        const body = await request.json();
        if (!body?.privateKey || typeof body.privateKey !== "string") {
            return NextResponse.json({ error: "privateKey is required" }, { status: 400 });
        }

        const status = await registerHyperliquidApiWallet({
            userAddress: session.address,
            isTestnet: parseIsTestnet(body),
            privateKey: body.privateKey
        });
        return NextResponse.json(status, { status: 201 });
    } catch (error) {
        return apiWalletErrorResponse(error, "Failed to register Hyperliquid API wallet");
    }
}

function isSecureRegistrationRequest(request: NextRequest): boolean {
    if (process.env.NODE_ENV !== "production") return true;
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    return request.nextUrl.protocol === "https:" || forwardedProto === "https";
}

export async function DELETE(request: NextRequest) {
    try {
        const session = requireWalletSession(request);
        const body = await request.json().catch(() => ({}));
        await deleteHyperliquidApiWallet(session.address, parseIsTestnet(body, request));
        return NextResponse.json({ ok: true });
    } catch (error) {
        return apiWalletErrorResponse(error, "Failed to delete Hyperliquid API wallet");
    }
}

function parseIsTestnet(body: any, request?: NextRequest): boolean {
    if (body?.network) return body.network === "testnet";
    if (typeof body?.isTestnet === "boolean") return body.isTestnet;
    if (request) return request.nextUrl.searchParams.get("network") !== "mainnet";
    return true;
}

function apiWalletErrorResponse(error: unknown, fallback: string) {
    const status = error instanceof WalletSessionError || error instanceof HyperliquidApiWalletError
        ? error.status
        : 500;
    return NextResponse.json({
        error: error instanceof Error ? error.message : fallback
    }, { status });
}
