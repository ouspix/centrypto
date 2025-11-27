
import { NextResponse } from "next/server";

export const dynamic = 'force-dynamic';

export async function GET() {
    return NextResponse.json({
        databaseUrl: process.env.DATABASE_URL,
        cwd: process.cwd(),
        nodeEnv: process.env.NODE_ENV
    });
}
