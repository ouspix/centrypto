import { NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { ownedBook, DeskInputError } from "@/lib/desk/books";
import { readBookUsage, usageDayWindow } from "@/lib/desk/token-usage";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
    const json = (value: unknown, status = 200) =>
        NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
    try {
        const { address } = requireWalletSession(request);
        const params = new URL(request.url).searchParams;
        const book = await ownedBook(address, params.get("bookId"));
        const day = params.get("day");
        try {
            usageDayWindow(day);
        } catch {
            return json({ error: "Choose a valid calendar date." }, 400);
        }
        return json(await readBookUsage(book.id, day));
    } catch (error) {
        if (error instanceof WalletSessionError || error instanceof DeskInputError)
            return json({ error: error.message }, error.status);
        return json({ error: "Sol usage unavailable. Check the local database and desk migrations." }, 503);
    }
}
