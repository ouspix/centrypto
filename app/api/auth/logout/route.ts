import { NextResponse } from "next/server";
import { WALLET_SESSION_COOKIE } from "@/lib/auth/wallet-session";

export async function POST() {
    const response = NextResponse.json({ success: true });
    response.cookies.delete(WALLET_SESSION_COOKIE);
    return response;
}
