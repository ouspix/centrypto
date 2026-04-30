import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_API_PREFIXES = [
    '/api/auth/challenge',
    '/api/auth/verify',
    '/api/auth/session',
    '/api/auth/logout',
    '/api/ai/models',
    '/api/candles',
    '/api/indicators',
    '/api/screener',
    '/api/sentiment',
    '/api/trade/execute'
];

const WALLET_REQUIRED_PREFIXES = [
    '/api/alerts',
    '/api/ai/analyze',
    '/api/ai/cancel',
    '/api/ai/job-status',
    '/api/hyperliquid/api-wallet',
    '/api/risk/kill-switch',
    '/api/trades'
];

const INTERNAL_REQUIRED_PREFIXES = [
    '/api/ai/cleanup-jobs',
    '/api/backtest/run',
    '/api/cron',
    '/api/llm/history'
];

const RATE_LIMIT_WINDOW_MS = 60_000;
const PUBLIC_RATE_LIMIT = 120;

const globalForMiddleware = globalThis as unknown as {
    __centryptoApiHits?: Map<string, { count: number; resetAt: number }>;
};

const hits = globalForMiddleware.__centryptoApiHits ?? new Map<string, { count: number; resetAt: number }>();
globalForMiddleware.__centryptoApiHits = hits;

export function middleware(request: NextRequest) {
    const path = request.nextUrl.pathname;
    if (!path.startsWith('/api/')) return NextResponse.next();

    if (matchesAny(path, INTERNAL_REQUIRED_PREFIXES)) {
        return enforceInternal(request);
    }

    if (matchesAny(path, WALLET_REQUIRED_PREFIXES)) {
        return NextResponse.next();
    }

    if (matchesAny(path, PUBLIC_API_PREFIXES)) {
        const limited = rateLimitPublic(request);
        if (limited) return limited;
        return NextResponse.next();
    }

    if (process.env.NODE_ENV === 'production') {
        return NextResponse.json({ error: 'API route is not classified for production access' }, { status: 404 });
    }

    return NextResponse.next();
}

function enforceInternal(request: NextRequest) {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected && process.env.NODE_ENV === 'production') {
        return NextResponse.json({ error: 'INTERNAL_API_TOKEN is required' }, { status: 503 });
    }
    if (!expected) return NextResponse.next();

    const authorization = request.headers.get('authorization');
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
    const provided = bearer || request.headers.get('x-internal-api-token');
    if (provided !== expected) {
        return NextResponse.json({ error: 'Internal API token required' }, { status: 401 });
    }
    return NextResponse.next();
}

function rateLimitPublic(request: NextRequest): NextResponse | null {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        'unknown';
    const key = `${ip}:${request.nextUrl.pathname}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return null;
    }
    entry.count++;
    if (entry.count > PUBLIC_RATE_LIMIT) {
        return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }
    return null;
}

function matchesAny(path: string, prefixes: string[]): boolean {
    return prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

export const config = {
    matcher: '/api/:path*',
};
