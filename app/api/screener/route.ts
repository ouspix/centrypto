import { NextResponse } from 'next/server';
import { AgentConfig, DEFAULT_AGENT_CONFIG } from '@/lib/agent-config';
import { DEFAULT_SCREENER_CONFIG, ScreenerConfig } from '@/lib/screener-config';
import { ScreenerService } from '@/services/ScreenerService';
import { ensureCollectorReady } from '@/services/CollectorRunner';

type ScreenedSymbols = Awaited<ReturnType<ScreenerService['getScreenedSymbols']>>;
type ScreeningResponse = {
    symbols: ScreenedSymbols;
    cached?: boolean;
    coalesced?: boolean;
};
type QueuedWaiter = {
    requestedKey: string;
    resolve: (value: ScreeningResponse) => void;
    reject: (reason?: unknown) => void;
};
type PendingScreening = {
    key: string;
    isTestnet: boolean;
    agentConfig: AgentConfig;
    screenerConfig: ScreenerConfig;
    waiters: QueuedWaiter[];
};
type NetworkScreenerState = {
    active?: {
        key: string;
        runId: number;
        controller: AbortController;
        waiters: QueuedWaiter[];
        transferred: boolean;
    };
    pending?: PendingScreening;
    timer?: ReturnType<typeof setTimeout>;
    nextRunId: number;
};

type ScreenerGlobalState = {
    screenerCache: Record<string, ScreenerService>;
    resultCache: Record<string, { expiresAt: number; symbols: ScreenedSymbols }>;
    states: Record<string, NetworkScreenerState>;
};

const globalForScreener = globalThis as unknown as {
    __centryptoScreener?: ScreenerGlobalState;
};

const screenerGlobal = globalForScreener.__centryptoScreener ?? {
    screenerCache: {},
    resultCache: {},
    states: {}
};
globalForScreener.__centryptoScreener = screenerGlobal;

const SCREENER_RESULT_TTL_MS = 60_000;
const SCREENER_START_DEBOUNCE_MS = 500;

function getScreener(isTestnet: boolean) {
    const key = isTestnet ? 'testnet' : 'mainnet';
    if (!screenerGlobal.screenerCache[key]) {
        screenerGlobal.screenerCache[key] = new ScreenerService(isTestnet);
    }
    return screenerGlobal.screenerCache[key];
}

function stableForCache(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stableForCache);
    }

    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
                acc[key] = stableForCache((value as Record<string, unknown>)[key]);
                return acc;
            }, {});
    }

    return value;
}

function getCacheKey(isTestnet: boolean, screenerConfig: ScreenerConfig) {
    return JSON.stringify(stableForCache({ isTestnet, screenerConfig }));
}

function getNetworkKey(isTestnet: boolean) {
    return isTestnet ? 'testnet' : 'mainnet';
}

function getState(isTestnet: boolean) {
    const key = getNetworkKey(isTestnet);
    if (!screenerGlobal.states[key]) screenerGlobal.states[key] = { nextRunId: 1 };
    return screenerGlobal.states[key];
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

async function runScreening(job: PendingScreening, signal: AbortSignal): Promise<ScreenedSymbols> {
    await ensureCollectorReady(job.isTestnet);
    return getScreener(job.isTestnet).getScreenedSymbols(job.isTestnet, [], job.agentConfig, job.screenerConfig, signal);
}

function scheduleNextScreening(isTestnet: boolean) {
    const state = getState(isTestnet);
    if (state.active || !state.pending) return;

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        state.timer = undefined;
        void runNextScreening(isTestnet);
    }, SCREENER_START_DEBOUNCE_MS);
}

async function runNextScreening(isTestnet: boolean) {
    const state = getState(isTestnet);
    if (state.active || !state.pending) return;

    const job = state.pending;
    state.pending = undefined;
    const runId = state.nextRunId++;
    const controller = new AbortController();
    state.active = {
        key: job.key,
        runId,
        controller,
        waiters: job.waiters,
        transferred: false
    };

    console.log(`[ScreenerAPI] Running ${getNetworkKey(isTestnet)} screening for ${job.waiters.length} request(s).`);

    try {
        const symbols = await runScreening(job, controller.signal);
        screenerGlobal.resultCache[job.key] = {
            expiresAt: Date.now() + SCREENER_RESULT_TTL_MS,
            symbols
        };

        for (const waiter of state.active?.waiters ?? []) {
            waiter.resolve({
                symbols,
                coalesced: waiter.requestedKey !== job.key
            });
        }
    } catch (error) {
        if (!isAbortError(error)) {
            for (const waiter of state.active?.waiters ?? []) {
                waiter.reject(error);
            }
        }
    } finally {
        if (state.active?.runId === runId) {
            state.active = undefined;
        }
        scheduleNextScreening(isTestnet);
    }
}

function appendPending(
    state: NetworkScreenerState,
    isTestnet: boolean,
    agentConfig: AgentConfig,
    screenerConfig: ScreenerConfig,
    cacheKey: string,
    waiters: QueuedWaiter[]
) {
    if (state.pending) {
        state.pending.key = cacheKey;
        state.pending.agentConfig = agentConfig;
        state.pending.screenerConfig = screenerConfig;
        state.pending.waiters.push(...waiters);
        return;
    }

    state.pending = {
        key: cacheKey,
        isTestnet,
        agentConfig,
        screenerConfig,
        waiters
    };
}

function enqueueScreening(
    isTestnet: boolean,
    agentConfig: AgentConfig,
    screenerConfig: ScreenerConfig,
    cacheKey: string
): Promise<ScreeningResponse> {
    const state = getState(isTestnet);

    return new Promise((resolve, reject) => {
        const waiter: QueuedWaiter = { requestedKey: cacheKey, resolve, reject };

        if (state.active) {
            if (!state.active.transferred && state.active.key === cacheKey) {
                state.active.waiters.push(waiter);
                return;
            }

            const transferredWaiters = state.active.transferred ? [] : state.active.waiters.splice(0);
            state.active.transferred = true;
            state.active.controller.abort();
            appendPending(state, isTestnet, agentConfig, screenerConfig, cacheKey, [...transferredWaiters, waiter]);
            console.log(`[ScreenerAPI] Cancelling ${getNetworkKey(isTestnet)} screening; newer config queued.`);
            return;
        }

        appendPending(state, isTestnet, agentConfig, screenerConfig, cacheKey, [waiter]);
        scheduleNextScreening(isTestnet);
    });
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { screeningConfig, isTestnet = true } = body;

        // Construct a valid AgentConfig
        // Construct a valid ScreenerConfig
        let screenerConfig: ScreenerConfig = DEFAULT_SCREENER_CONFIG;
        let agentConfig: AgentConfig = DEFAULT_AGENT_CONFIG;

        if (screeningConfig) {
            // Check if it's a full config (has 'screener' property) or just screener params (legacy)
            if (screeningConfig.screener) {
                // If passed as part of full config
                screenerConfig = { ...DEFAULT_SCREENER_CONFIG, ...screeningConfig.screener };
                agentConfig = { ...DEFAULT_AGENT_CONFIG, ...screeningConfig };
            } else if (screeningConfig.topN !== undefined || screeningConfig.layer1Enabled !== undefined) {
                // It IS the ScreenerConfig (from ScreeningParameters)
                screenerConfig = { ...DEFAULT_SCREENER_CONFIG, ...screeningConfig };
            } else {
                // Legacy: screeningConfig IS the screener params (camelCase) but maybe missing some fields
                // We need to map these to the structure
                // Actually, ScreeningParameters ALREADY uses the structure that matches ScreenerConfig mostly.
                // The only difference was AgentConfig used snake_case.
                // Now ScreenerConfig uses camelCase (mostly, based on my definition).
                // Wait, my definition of ScreenerConfig in lib/screener-config.ts used camelCase for UI props?
                // Let me check lib/screener-config.ts content I wrote.
                // Yes, I used camelCase for UI props like minVolume24h.

                // So if screeningConfig comes from UI, it matches ScreenerConfig.
                screenerConfig = { ...DEFAULT_SCREENER_CONFIG, ...screeningConfig };
            }
        }

        const cacheKey = getCacheKey(isTestnet, screenerConfig);
        const cached = screenerGlobal.resultCache[cacheKey];
        if (cached && cached.expiresAt > Date.now()) {
            console.log(`[ScreenerAPI] Returning cached ${getNetworkKey(isTestnet)} screening.`);
            return NextResponse.json({ symbols: cached.symbols, cached: true });
        }

        const result = await enqueueScreening(isTestnet, agentConfig, screenerConfig, cacheKey);

        return NextResponse.json(result);
    } catch (error) {
        console.error('Screener API Error:', error);
        return NextResponse.json({
            error: 'Screening failed',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
