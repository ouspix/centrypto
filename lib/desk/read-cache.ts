/** One instance per deskTools/shift. The signer, position manager and execution preview never use this cache. */
export class ShiftReads {
    private readonly items = new Map<string, { pending: Promise<Observation<unknown>>; expires: number }>();

    constructor(
        private readonly now = Date.now,
        private readonly limit = 128,
    ) {}

    async read<T>(key: string, ttl: number, fetch: () => Promise<T>, validUntil?: (value: T) => number) {
        const cached = this.items.get(key);
        if (cached && cached.expires > this.now())
            return { ...((await cached.pending) as Observation<T>), reused: true };
        // A rejected or expired snapshot is never served as fallback.
        const request = Promise.resolve()
            .then(fetch)
            .then((value) => {
                const observedAt = this.now();
                const expiresAt = Math.min(observedAt + ttl, validUntil?.(value) ?? Infinity);
                if (expiresAt <= observedAt) throw new Error("Observation expired during retrieval");
                if (this.items.get(key)?.pending === request) this.items.get(key)!.expires = expiresAt;
                return { value, observedAt, expiresAt };
            })
            .catch((error) => {
                if (this.items.get(key)?.pending === request) this.items.delete(key);
                throw error;
            });
        if (!cached && this.items.size >= this.limit) this.items.delete(this.items.keys().next().value!);
        this.items.set(key, { pending: request, expires: Infinity });
        return { ...(await request), reused: false };
    }
}

/** Compact facts for the next specialist/lead/consultation opening brief, scoped to the shift. */
export class ShiftObservationBoard {
    private readonly facts = new Map<
        string,
        { expires: number; fact: Record<string, unknown>; current?: () => Promise<boolean> }
    >();
    constructor(private readonly now = Date.now) {}
    publish(key: string, expires: number, fact: Record<string, unknown>, current?: () => Promise<boolean>) {
        if (!Number.isFinite(expires) || expires <= this.now()) return;
        this.facts.delete(key);
        if (this.facts.size >= 16) this.facts.delete(this.facts.keys().next().value!);
        this.facts.set(key, { expires, fact, current });
    }
    async recent() {
        const result: Record<string, unknown>[] = [];
        let bytes = 0;
        for (const [key, entry] of [...this.facts.entries()].reverse()) {
            if (entry.expires <= this.now() || (entry.current && !(await entry.current().catch(() => false)))) {
                if (this.facts.get(key) === entry) this.facts.delete(key);
                continue;
            }
            const size = Buffer.byteLength(JSON.stringify(entry.fact), "utf8");
            if (bytes + size > 2400) continue;
            bytes += size;
            result.push(entry.fact);
            if (result.length >= 6) break;
        }
        return result;
    }
}

type Observation<T> = { value: T; observedAt: number; expiresAt: number };
export function timeOf(read: { observedAt: number; expiresAt: number; reused: boolean }) {
    return {
        retrievedAt: new Date(read.observedAt).toISOString(),
        expiresAt: new Date(read.expiresAt).toISOString(),
        reused: read.reused,
    };
}
