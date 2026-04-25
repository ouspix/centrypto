import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
    // Only apply to /api/ routes
    if (request.nextUrl.pathname.startsWith('/api/')) {
        const authHeader = request.headers.get('authorization');
        
        // Define your expected token here or read from process.env.API_SECRET_TOKEN
        // During dev, allow it to pass if not configured, or enforce it in production.
        const expectedToken = process.env.API_SECRET_TOKEN;

        // If a token is configured in the environment, enforce it
        if (expectedToken) {
            if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
                return NextResponse.json(
                    { error: 'Unauthorized: Missing or invalid API token' },
                    { status: 401 }
                );
            }
        }
    }

    return NextResponse.next();
}

export const config = {
    matcher: '/api/:path*',
};
