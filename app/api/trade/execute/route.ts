import { NextResponse } from "next/server";

export async function POST() {
    return NextResponse.json(
        {
            error: "Deprecated endpoint. Mock trade execution has been removed; use wallet-session authenticated execution paths."
        },
        { status: 410 }
    );
}
