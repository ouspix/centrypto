import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";

export const contextResponse = (value: unknown, status = 200) =>
    NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });

export async function withContextBook<T>(
    request: Request,
    read: (book: { id: string; isTestnet: boolean }, params: URLSearchParams) => Promise<T | Response>,
) {
    try {
        const { address } = requireWalletSession(request);
        const params = new URL(request.url).searchParams;
        const network = params.get("network"), id = params.get("bookId");
        if (!id || !["mainnet", "testnet"].includes(network ?? ""))
            return contextResponse({ error: "Choose a book and network." }, 400);
        const book = await prisma.deskBook.findFirst({ where: { id, ownerAddress: address, isTestnet: network === "testnet" },
            select: { id: true, isTestnet: true } });
        if (!book) return contextResponse({ error: "Book not found." }, 404);
        const result = await read(book, params);
        return result instanceof Response ? result : contextResponse(result);
    } catch (error) {
        if (error instanceof WalletSessionError) return contextResponse({ error: error.message }, 401);
        return contextResponse({ error: "Desk market context could not be read." }, 503);
    }
}
