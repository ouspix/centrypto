import { intervals, minute, relative, type MarketFeatureRow, type MarketFeatureSnapshot, type ScreenTimeframe } from "./market-features";

export const views = ["relative", "compression", "breakout", "pullback", "dislocation", "catalyst"] as const;
export type ScreenView = typeof views[number];
export type Direction = "long" | "short";
export const metrics = {
    relativeBtcBps: "basis points", relativeEthBps: "basis points",
    normalizedRelativeBtc: "relative BTC return / ATR in basis points", normalizedRelativeEth: "relative ETH return / ATR in basis points",
    returnBps: "basis points", atrBps: "basis points", realizedVolBps: "basis points",
    volatilityPercentile: "percentile (0–100)", trendEfficiency: "ratio (0–1)", trendReturnBps: "basis points",
    compression: "five-bar range / prior 20-bar range", rangePosition: "ratio; outside [0,1] is beyond the prior range",
    relativeVolume: "latest completed quote volume / prior 20-bar mean",
    highDistanceAtr: "ATR units, positive above prior high", lowDistanceAtr: "ATR units, positive below prior low",
    displacementAtr: "ATR units, signed distance from prior mean", retracementAtr: "ATR units",
    volume24h: "USD", oiChange1hPct: "percent, base-unit OI", openInterestUsd: "USD",
    fundingHourly: "decimal per hour", fundingPercentile: "percentile (0–100)", basisBps: "basis points, mark versus index",
    spreadBps: "basis points, collector top of book",
} as const;
export type Metric = keyof typeof metrics;
const metricNames = Object.keys(metrics) as Metric[];
const operators = ["gte", "lte", "gt", "lt", "eq"] as const;
type Filter = { metric: Metric; op: typeof operators[number]; value: number };
type Sort = { metric: Metric; order: "asc" | "desc" };
export type ScreenQuery = {
    preset: "balanced" | ScreenView; timeframe: ScreenTimeframe; direction: Direction | "both";
    benchmark: "BTC" | "ETH"; filters: Filter[]; sort: Sort[]; limit: number; nominate: string[]; cursor?: string;
};
export type Catalyst = {
    instrumentId: string; eventKey: string; summary: string; direction: string; materiality: number;
    claimType: string; confidence: number; contradictions: string[]; evidenceIds: string[]; availableAt: string;
    expiresAt: string; deadline: string | null;
};
export const screenQueryProperties = {
    preset: { type: "string", enum: ["balanced", ...views] },
    timeframe: { type: "string", enum: Object.keys(intervals) },
    direction: { type: "string", enum: ["both", "long", "short"] },
    benchmark: { type: "string", enum: ["BTC", "ETH"] },
    filters: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["metric", "op", "value"],
        properties: { metric: { type: "string", enum: metricNames }, op: { type: "string", enum: operators }, value: { type: "number" } } } },
    sort: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["metric", "order"],
        properties: { metric: { type: "string", enum: metricNames }, order: { type: "string", enum: ["asc", "desc"] } } } },
    limit: { type: "integer", minimum: 1, maximum: 20 },
    nominate: { type: "array", maxItems: 5, items: { type: "string", maxLength: 120 } },
    cursor: { type: "string", maxLength: 512 },
};
export const screeningCatalog = {
    version: 1, metrics, timeframes: Object.keys(intervals), operators, defaults: { limit: 10, preset: "balanced", timeframe: "1h", direction: "both", benchmark: "BTC" },
    presets: {
        balanced: "Round-robin across views and directions, deduplicated by instrument.",
        relative: "Signed matching-horizon return difference versus the selected benchmark, divided by ATR in basis points; trend efficiency breaks ties.",
        compression: "Five-bar range divided by the preceding 20-bar range, then distance to the prior boundary.",
        breakout: "Prior 20-bar boundary within one ATR before or two ATR after the close. Prefer a fresh close crossing, then higher relative volume.",
        pullback: "Direction of 20-bar move with an opposing latest completed bar and retracement within 0–3 ATR. Prefer efficient trend, then a retracement near one ATR.",
        dislocation: "Absolute distance from preceding 20-bar mean, in ATR. Side describes the possible fade.",
        catalyst: "Exact instrument mappings from active News Intelligence events, sorted by materiality and availability time.",
    },
    data: "Requires complete closed bars for structural metrics. Collector prices, spreads and funding carry their own timestamps. Ranks prioritize investigation.",
};

type Row = Record<string, unknown>;
function record(value: unknown): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a screen query object");
    return value as Row;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
    if (!allowed.includes(value as T)) throw new Error("Invalid " + name);
    return value as T;
}
function array(value: unknown, max: number, name: string): unknown[] {
    if (!Array.isArray(value) || value.length > max) throw new Error("Invalid " + name);
    return value;
}
function exactKeys(row: Row, keys: string[]) {
    if (Object.keys(row).some(key => !keys.includes(key))) throw new Error("Unknown screen query field");
}
export function parseScreenQuery(value: unknown): ScreenQuery {
    const input = record(value);
    exactKeys(input, Object.keys(screenQueryProperties));
    const filters = array(input.filters ?? [], 8, "filters").map(value => {
        const row = record(value);
        exactKeys(row, ["metric", "op", "value"]);
        if (typeof row.value !== "number" || !Number.isFinite(row.value)) throw new Error("Invalid filter value");
        return { metric: oneOf(row.metric, metricNames, "metric"), op: oneOf(row.op, operators, "operator"), value: row.value };
    });
    const sort = array(input.sort ?? [], 3, "sort").map(value => {
        const row = record(value);
        exactKeys(row, ["metric", "order"]);
        return { metric: oneOf(row.metric, metricNames, "metric"), order: oneOf(row.order, ["asc", "desc"] as const, "order") };
    });
    const limit = input.limit ?? 10;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid limit");
    const nominate = array(input.nominate ?? [], 5, "nominate").map(id => {
        if (typeof id !== "string" || !/^[^\s]{1,120}$/.test(id)) throw new Error("Invalid instrument nomination");
        return id;
    });
    const cursor = input.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))) throw new Error("Invalid cursor");
    return {
        preset: oneOf(input.preset ?? "balanced", ["balanced", ...views] as const, "preset"),
        timeframe: oneOf(input.timeframe ?? "1h", Object.keys(intervals) as ScreenTimeframe[], "timeframe"),
        direction: oneOf(input.direction ?? "both", ["both", "long", "short"] as const, "direction"),
        benchmark: oneOf(input.benchmark ?? "BTC", ["BTC", "ETH"] as const, "benchmark"),
        filters, sort, limit, nominate: [...new Set(nominate)], cursor,
    };
}
export type ScreenCandidate = {
    instrumentId: string; symbol: string; observedAt: number; closedAt: number | null;
    view: ScreenView | "custom"; direction: Direction | null; reason: string; values: Record<Metric, number | null>;
    priorHigh: number | null; priorLow: number | null; catalyst?: Catalyst;
};
type Ranked = ScreenCandidate & { order: number[] };
const matches = (value: number, { op, value: threshold }: Filter) =>
    ({ gte: value >= threshold, lte: value <= threshold, gt: value > threshold, lt: value < threshold, eq: value === threshold })[op];

export function rankScreen(snapshot: MarketFeatureSnapshot, query: ScreenQuery, catalysts: Catalyst[], at: number) {
    const { timeframe: tf, direction, preset, benchmark, filters, sort } = query;
    const btc = snapshot.instruments.find(r => r.symbol === "BTC");
    const eth = snapshot.instruments.find(r => r.symbol === "ETH");
    const coverage = { eligible: snapshot.instruments.length, fresh: 0, structural: 0, missingFilter: 0, filteredOut: 0 };
    const buckets = new Map<string, Ranked[]>();
    const valuesById = new Map<string, Record<Metric, number | null>>();
    const eventById = new Map<string, Catalyst[]>();
    for (const event of catalysts) {
        if (Date.parse(event.availableAt) <= at && Date.parse(event.expiresAt) > at)
            eventById.set(event.instrumentId, [...(eventById.get(event.instrumentId) ?? []), event]);
    }
    const compare = (a: Ranked, b: Ranked) => {
        for (const { metric, order } of sort) {
            const av = a.values[metric], bv = b.values[metric];
            if (av == null && bv != null) return 1;
            if (av != null && bv == null) return -1;
            if (av != null && bv != null && av !== bv) return (av - bv) * (order === "asc" ? 1 : -1);
        }
        for (let i = 0; i < Math.min(a.order.length, b.order.length); i++) if (a.order[i] !== b.order[i]) return b.order[i] - a.order[i];
        return a.instrumentId.localeCompare(b.instrumentId);
    };
    function add(row: MarketFeatureRow, values: Record<Metric, number | null>, view: ScreenCandidate["view"],
        side: Direction | null, reason: string, order: number[], catalyst?: Catalyst) {
        if (direction !== "both" && side !== direction) return;
        if (preset !== "balanced" && view !== preset) return;
        const bucket = view + ":" + (side ?? "neutral");
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        const f = row.frame[tf];
        buckets.get(bucket)!.push({ instrumentId: row.instrumentId, symbol: row.symbol, observedAt: row.observedAt!,
            closedAt: f?.closedAt ?? null, view, direction: side, reason, values, order,
            priorHigh: f?.priorHigh ?? null, priorLow: f?.priorLow ?? null, ...(catalyst ? { catalyst } : {}) });
    }
    for (const row of snapshot.instruments) {
        if (row.observedAt == null || row.observedAt > at + 1000 || row.observedAt < at - 2 * minute) continue;
        coverage.fresh++;
        const f = row.frame[tf];
        if (f) coverage.structural++;
        const relativeBtcBps = relative(row, btc, tf), relativeEthBps = relative(row, eth, tf);
        const normalized = (v: number | null) => v != null && f?.atrBps ? v / f.atrBps : null;
        const values = {
            relativeBtcBps, relativeEthBps, normalizedRelativeBtc: normalized(relativeBtcBps), normalizedRelativeEth: normalized(relativeEthBps),
            returnBps: row.changes[tf], atrBps: f?.atrBps ?? null, realizedVolBps: f?.realizedVolBps ?? null,
            volatilityPercentile: f?.volatilityPercentile ?? null, trendEfficiency: f?.trendEfficiency ?? null,
            trendReturnBps: f?.trendReturnBps ?? null, compression: f?.compression ?? null, rangePosition: f?.rangePosition ?? null,
            relativeVolume: f?.relativeVolume ?? null, highDistanceAtr: f?.highDistanceAtr ?? null, lowDistanceAtr: f?.lowDistanceAtr ?? null,
            displacementAtr: f?.displacementAtr ?? null, retracementAtr: f?.retracementAtr ?? null, volume24h: row.volume24h,
            oiChange1hPct: row.oiChange1hPct, openInterestUsd: row.openInterestUsd, fundingHourly: row.fundingHourly,
            fundingPercentile: row.fundingPercentile, basisBps: row.basisBps, spreadBps: row.spreadBps,
        };
        valuesById.set(row.instrumentId, values);
        if (filters.some(filter => values[filter.metric] == null)) { coverage.missingFilter++; continue; }
        if (filters.some(filter => !matches(values[filter.metric]!, filter))) { coverage.filteredOut++; continue; }
        if (preset === "balanced" && (filters.length || sort.length)) {
            const side = Math.sign(f?.trendReturnBps ?? row.changes[tf] ?? 0);
            add(row, values, "custom", side === 0 ? null : side > 0 ? "long" : "short", "Matches the requested screen criteria", []);
            continue;
        }
        const rs = benchmark === "BTC" ? values.normalizedRelativeBtc : values.normalizedRelativeEth;
        if (rs != null && rs !== 0)
            add(row, values, "relative", rs > 0 ? "long" : "short", "Normalized relative performance versus " + benchmark, [Math.abs(rs), f?.trendEfficiency ?? 0]);
        if (f) {
            for (const side of ["long", "short"] as const) {
                const d = side === "long" ? f.highDistanceAtr : f.lowDistanceAtr;
                const crossed = side === "long" ? f.previousClose <= f.priorHigh : f.previousClose >= f.priorLow;
                if (d != null && f.compression != null && f.compression <= .75 && d <= 0)
                    add(row, values, "compression", side, "Compressed range approaching a prior boundary", [-f.compression, d]);
                if (d != null && d >= -1 && d <= 2)
                    add(row, values, "breakout", side, d > 0 && crossed ? "Closed beyond the prior range boundary" : "Within the breakout research band",
                        [Number(d > 0 && crossed), f.relativeVolume ?? 0, -Math.abs(d)]);
            }
            if (f.retracementAtr != null && f.retracementAtr >= 0 && f.retracementAtr <= 3 && f.trendReturnBps * f.barReturnBps < 0)
                add(row, values, "pullback", f.trendReturnBps > 0 ? "long" : "short", "Latest bar retraced the prevailing move",
                    [f.trendEfficiency ?? 0, -Math.abs(f.retracementAtr - 1)]);
            if (f.displacementAtr != null && Math.abs(f.displacementAtr) >= 1)
                add(row, values, "dislocation", f.displacementAtr < 0 ? "long" : "short", "Displaced at least one ATR from the prior mean", [Math.abs(f.displacementAtr)]);
        }
        for (const event of eventById.get(row.instrumentId) ?? []) {
            add(row, values, "catalyst", event.direction === "bullish" ? "long" : event.direction === "bearish" ? "short" : null,
                "Active News Intelligence event with an exact instrument mapping", [event.materiality, Date.parse(event.availableAt)], event);
        }
    }
    const groups = [...buckets.entries()].sort(([a], [b]) => {
        const order = (key: string) => views.indexOf(key.split(":")[0] as ScreenView);
        return order(a) - order(b) || a.localeCompare(b);
    }).map(([, rows]) => rows.sort(compare));
    const selected = new Map<string, Ranked>();
    if (sort.length || direction !== "both") {
        for (const row of groups.flat().sort(compare)) if (!selected.has(row.instrumentId)) selected.set(row.instrumentId, row);
    } else {
        const depth = Math.max(0, ...groups.map(g => g.length));
        for (let i = 0; i < depth; i++) for (const group of groups) {
            const row = group[i];
            if (row && !selected.has(row.instrumentId)) selected.set(row.instrumentId, row);
        }
    }
    const candidates = [...selected.values()].map(({ order: _order, ...row }) => row);
    return { candidates, coverage, valuesById };
}
