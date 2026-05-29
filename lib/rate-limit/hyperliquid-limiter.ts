type CacheEntry<T> = {
    value?: T;
    expiresAt: number;
    staleUntil: number;
    inFlight?: Promise<T>;
};

type RequestOptions = {
    ttlMs?: number;
    staleMs?: number;
    maxRetries?: number;
    allowStale?: boolean;
    retryOrders?: boolean;
    walletKey?: string;
};

const DEFAULT_MIN_DELAY_MS: Record<string, number> = {
    "hl:info:meta": 250,
    "hl:info:metaAndAssetCtxs": 350,
    "hl:info:clearinghouseState": 250,
    "hl:info:spotClearinghouseState": 250,
    "hl:info:allMids": 250,
    "hl:info:userFills": 250,
    "hl:info:userFillsByTime": 250,
    "hl:info:openOrders": 250,
    "hl:info:frontendOpenOrders": 250,
    "hl:info:orderStatus": 250,
    "hl:info:candleSnapshot": 800,
    "hl:info:l2Book": 500,
    "hl:info:extraAgents": 500,
    "hl:exchange:order": 150,
    "hl:exchange:cancel": 150,
    "hl:exchange:updateLeverage": 150
};

const globalForLimiter = globalThis as unknown as {
    __centryptoHlLimiter?: {
        buckets: Map<string, Promise<void>>;
        lastAt: Map<string, number>;
        cache: Map<string, CacheEntry<unknown>>;
    };
};

const state = globalForLimiter.__centryptoHlLimiter ?? {
    buckets: new Map<string, Promise<void>>(),
    lastAt: new Map<string, number>(),
    cache: new Map<string, CacheEntry<unknown>>()
};
globalForLimiter.__centryptoHlLimiter = state;

export async function waitForHyperliquidSlot(bucket: string = "hl:info:metaAndAssetCtxs"): Promise<void> {
    await enqueue(bucket, async () => {});
}

export async function hyperliquidInfoPost<T>(
    bucket: "hl:info:meta" | "hl:info:metaAndAssetCtxs" | "hl:info:clearinghouseState" | "hl:info:spotClearinghouseState" | "hl:info:allMids" | "hl:info:userFills" | "hl:info:userFillsByTime" | "hl:info:openOrders" | "hl:info:frontendOpenOrders" | "hl:info:orderStatus" | "hl:info:candleSnapshot" | "hl:info:l2Book" | "hl:info:extraAgents",
    apiUrl: string,
    body: unknown,
    options: RequestOptions = {}
): Promise<T> {
    const cacheKey = `${bucket}:${apiUrl}:${stableStringify(body)}`;
    const now = Date.now();
    const cached = state.cache.get(cacheKey) as CacheEntry<T> | undefined;

    if (cached?.value !== undefined && cached.expiresAt > now) {
        return cached.value;
    }

    if (cached?.inFlight) return cached.inFlight;

    const inFlight = fetchWithRateLimit<T>(bucket, apiUrl, body, {
        maxRetries: options.maxRetries ?? 3,
        retryOrders: false
    }).then(value => {
        const ttlMs = options.ttlMs ?? 0;
        const staleMs = options.staleMs ?? ttlMs;
        state.cache.set(cacheKey, {
            value,
            expiresAt: Date.now() + ttlMs,
            staleUntil: Date.now() + ttlMs + staleMs
        });
        return value;
    }).catch(error => {
        if (options.allowStale && cached?.value !== undefined && cached.staleUntil > Date.now()) {
            return cached.value;
        }
        throw error;
    }).finally(() => {
        const latest = state.cache.get(cacheKey);
        if (latest?.inFlight === inFlight) {
            latest.inFlight = undefined;
        }
    });

    state.cache.set(cacheKey, {
        value: cached?.value,
        expiresAt: cached?.expiresAt ?? 0,
        staleUntil: cached?.staleUntil ?? 0,
        inFlight
    });

    return inFlight;
}

export async function hyperliquidExchangePost<T>(
    bucket: "hl:exchange:order" | "hl:exchange:cancel" | "hl:exchange:updateLeverage",
    apiUrl: string,
    body: unknown,
    options: RequestOptions = {}
): Promise<T> {
    const walletBucket = options.walletKey ? `${bucket}:${options.walletKey.toLowerCase()}` : bucket;
    return fetchWithRateLimit<T>(walletBucket, apiUrl, body, {
        maxRetries: options.retryOrders ? options.maxRetries ?? 1 : 0,
        retryOrders: !!options.retryOrders
    });
}

export function clearHyperliquidLimiterState(): void {
    state.buckets.clear();
    state.lastAt.clear();
    state.cache.clear();
}

async function fetchWithRateLimit<T>(
    bucket: string,
    apiUrl: string,
    body: unknown,
    options: { maxRetries: number; retryOrders: boolean }
): Promise<T> {
    let attempt = 0;
    while (true) {
        const response = await enqueue(bucket, () => fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }));

        if (response.status !== 429) {
            if (!response.ok) {
                throw new Error(`Hyperliquid ${bucket} failed: ${response.status} ${await response.text()}`);
            }
            return response.json() as Promise<T>;
        }

        if (attempt >= options.maxRetries) {
            throw new Error(`Hyperliquid ${bucket} rate limited`);
        }

        await sleep(backoffWithJitter(attempt));
        attempt++;
    }
}

async function enqueue<T>(bucket: string, work: () => Promise<T> | T): Promise<T> {
    const previous = state.buckets.get(bucket) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
        release = resolve;
    });
    const chained = previous.then(() => current, () => current);
    state.buckets.set(bucket, chained);

    await previous.catch(() => {});
    try {
        const baseBucket = bucket.split(":").slice(0, 3).join(":");
        const minDelay = Number(process.env.HL_MIN_DELAY_MS ?? DEFAULT_MIN_DELAY_MS[baseBucket] ?? 500);
        const lastAt = state.lastAt.get(bucket) ?? 0;
        const waitMs = Math.max(0, minDelay - (Date.now() - lastAt));
        if (waitMs > 0) await sleep(waitMs);
        state.lastAt.set(bucket, Date.now());
        return await work();
    } finally {
        release();
        if (state.buckets.get(bucket) === chained) {
            state.buckets.delete(bucket);
        }
    }
}

function backoffWithJitter(attempt: number): number {
    const base = Number(process.env.HL_RETRY_BASE_MS ?? 500);
    const cap = Number(process.env.HL_RETRY_CAP_MS ?? 10_000);
    const exponential = Math.min(cap, base * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * Math.max(1, exponential * 0.25));
    return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
