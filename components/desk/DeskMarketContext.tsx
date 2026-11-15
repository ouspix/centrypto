"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, ListFilter, RefreshCw } from "lucide-react";
import type { MarketContextSnapshot, ScreenResult } from "@/lib/desk/market-context";
import type { ScreenQuery } from "@/lib/desk/market-screen";
import type { Book } from "./desk-view";

type Review = { shiftId: string; evidenceId: string; recordedAt: string };
type ContextResponse = { context: MarketContextSnapshot; reviews: Review[] };
const views: [ScreenQuery["preset"], string][] = [
    ["balanced", "Balanced"], ["relative", "Relative performance"], ["compression", "Compression"],
    ["breakout", "Breakout"], ["pullback", "Pullback"], ["dislocation", "Dislocation"], ["catalyst", "Catalysts"],
];
const frameLabels = ["15m", "1h", "4h", "24h"] as const;
const viewLabels = Object.fromEntries([...views, ["custom", "Custom"]]);
const num = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const change = (value: number | null | undefined) => value == null ? "—" : (value > 0 ? "+" : "") + num(value / 100) + "%";
const tone = (value: number | null | undefined) => value == null || value === 0 ? "neutral" : value > 0 ? "up" : "down";
const statusLabel = (status: string) => status === "incomplete" ? "Partial coverage" : status.replaceAll("_", " ");
const timestamp = (value: string | number) => new Date(value).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});
const calendarDate = (date: string) => new Date(date + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const percent = (value: number | null | undefined) => value == null ? "—" : num(value) + "%";

function MarketOverview({ context }: { context: MarketContextSnapshot }) {
    const benchmarks = context.benchmarks ?? [];
    const breadth = context.breadth?.["1h"];
    const advances = breadth?.advancing ?? 0;
    const declines = breadth?.declining ?? 0;
    const measured = breadth?.measured ?? 0;
    const flat = Math.max(0, measured - advances - declines);
    const advancingShare = measured ? 100 * advances / measured : null;

    return <>
        <section className="desk-market-overview" aria-label="Market overview">
            {["BTC", "ETH"].map(symbol => {
                const benchmark = benchmarks.find(item => item.symbol === symbol);
                const hourly = benchmark?.returnsBps["1h"];
                return <article className="desk-market-tile" key={symbol}>
                    <h3><span className="desk-market-coin" data-coin={symbol} aria-hidden="true">{symbol === "BTC" ? "₿" : "Ξ"}</span>{symbol}</h3>
                    <div className="desk-market-value"><strong data-tone={tone(hourly)}>{change(hourly)}</strong><span>1h return</span></div>
                    <dl className="desk-market-mini">
                        {frameLabels.filter(period => period !== "1h").map(period => <div key={period}>
                            <dt>{period}</dt><dd data-tone={tone(benchmark?.returnsBps[period])}>{change(benchmark?.returnsBps[period])}</dd>
                        </div>)}
                    </dl>
                </article>;
            })}
            <article className="desk-market-tile desk-market-breadth">
                <h3>Market breadth <span>1h</span></h3>
                <div className="desk-market-value"><strong>{percent(advancingShare)}</strong><span>advancing</span></div>
                {measured > 0 ? <>
                    <div className="desk-market-breadth-bar" aria-hidden="true">
                        <span data-tone="up" style={{ flexGrow: advances }} /><span data-tone="neutral" style={{ flexGrow: flat }} /><span data-tone="down" style={{ flexGrow: declines }} />
                    </div>
                    <p className="desk-market-breadth-legend"><span data-tone="up">{advances} up</span>{flat > 0 && <span>{flat} flat</span>}<span data-tone="down">{declines} down</span></p>
                </> : <p className="desk-market-quiet">Hourly breadth unavailable</p>}
            </article>
        </section>
        <details className="desk-market-details">
            <summary>Market measurements <span>{context.coverage.fresh}/{context.coverage.eligible} markets observed</span></summary>
            <div className="desk-market-details-grid">
                <section aria-label="Breadth by timeframe">
                    <h3>Breadth by timeframe</h3>
                    <dl className="desk-market-facts">{frameLabels.map(period => {
                        const row = context.breadth?.[period];
                        return <div key={period}><dt>{period}</dt><dd>{row?.measured ? <>
                            {row.advancing} up / {row.declining} down <span>· {change(row.medianBps)} median · {row.measured}/{row.eligible} measured</span>
                            {row.advancingChangePp != null && <span> · {num(row.advancingChangePp)} pp breadth change</span>}
                        </> : "Unavailable"}</dd></div>;
                    })}</dl>
                </section>
                <section aria-label="Benchmark structure and positioning">
                    <h3>Benchmark structure and positioning</h3>
                    <dl className="desk-market-facts">{["BTC", "ETH"].map(symbol => {
                        const frame = benchmarks.find(item => item.symbol === symbol)?.frame["1h"];
                        const position = context.positioning?.benchmarks.find(item => item.symbol === symbol);
                        return <div key={symbol}><dt>{symbol}</dt><dd>
                            <span>1h range {frame ? num(frame.priorLow) + "–" + num(frame.priorHigh) : "—"}</span>
                            <span> · Volatility percentile {num(frame?.volatilityPercentile)}</span>
                            <span> · OI {percent(position?.oiChange1hPct)} · Funding percentile {num(position?.fundingPercentile)}</span>
                        </dd></div>;
                    })}</dl>
                    <p className="desk-market-quiet">Spreads measured on {context.liquidity?.measured ?? 0} markets</p>
                </section>
            </div>
        </details>
    </>;
}

function MarketEvents({ context }: { context: MarketContextSnapshot | null }) {
    const [feed, setFeed] = useState<"calendar" | "news">("calendar");
    const [expanded, setExpanded] = useState(false);
    const sources = context?.calendar ?? [];
    const upcoming = sources.flatMap(source => source.events).sort((a, b) =>
        a.date.localeCompare(b.date) || (a.startsAt ?? "").localeCompare(b.startsAt ?? "") || a.id.localeCompare(b.id));
    const news = context?.news;
    const entries = news?.events ?? [];
    const count = feed === "calendar" ? upcoming.length : entries.length;
    const limit = expanded ? count : 3;
    const choose = (value: typeof feed) => { setFeed(value); setExpanded(false); };

    return <section className="desk-market-surface desk-market-events" aria-label="News and calendar">
        <header className="desk-market-section-heading">
            <h3><CalendarDays size={16} aria-hidden="true" /> Events</h3>
        </header>
        <div className="desk-market-feed-switch" aria-label="Event view" role="group">
            <button type="button" aria-pressed={feed === "calendar"} onClick={() => choose("calendar")}>Calendar</button>
            <button type="button" aria-pressed={feed === "news"} onClick={() => choose("news")}>Market news</button>
        </div>
        {!context ? <p className="desk-market-empty" role="status">Waiting for event data…</p> : feed === "calendar" ? <>
            <p className="desk-market-feed-meta">Next 7 days <span>{sources.length ? sources.map(source =>
                source.source.toUpperCase() + " " + statusLabel(source.status).toLowerCase()).join(" · ") : "Coverage unavailable"}</span></p>
            {upcoming.length ? <ul className="desk-market-event-list">{upcoming.slice(0, limit).map(event =>
                <li key={event.id}>
                    <span className="desk-market-event-date">{calendarDate(event.date)}</span>
                    <div><a href={event.url} target="_blank" rel="noreferrer">{event.title}<ArrowUpRight size={12} aria-hidden="true" /></a>
                        <p>{event.startsAt ? <time dateTime={event.startsAt}>{new Date(event.startsAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}</time> : "Time unpublished"} · {event.source.toUpperCase()}</p></div>
                </li>)}</ul> : <p className="desk-market-empty">{sources.length > 0 && sources.every(source => source.status === "healthy")
                    ? "No covered releases in the next 7 days." : "No upcoming releases available from the covered sources."}</p>}
        </> : <>
            <p className="desk-market-feed-meta">{news ? statusLabel(news.status) : "Unavailable"}
                {news && news.coverage.configured > 0 && <span>{news.coverage.healthy}/{news.coverage.configured} sources healthy</span>}</p>
            {entries.length ? <ul className="desk-market-news-list">{entries.slice(0, limit).map(event =>
                <li key={event.eventKey}>
                    <p>{event.summary}</p>
                    <div className="desk-market-news-sources">{event.evidenceIds.flatMap(id => {
                        const source = news?.evidence.find(item => item.id === id);
                        if (!source) return [];
                        return [<span key={id}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.source}<ArrowUpRight size={12} aria-hidden="true" /></a> : source.source}
                            {source.publishedAt && <> · <time dateTime={source.publishedAt}>{timestamp(source.publishedAt)}</time></>}</span>];
                    })}</div>
                </li>)}</ul> : <p className="desk-market-empty">{news?.status === "healthy" ? "No active market-wide news." : "Market-wide news is unavailable."}</p>}
        </>}
        {count > 3 && <button className="desk-market-more" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
            {expanded ? "Show fewer" : "Show all " + count}
        </button>}
    </section>;
}

function ScreenRows({ screen }: { screen: ScreenResult }) {
    return <div className="desk-market-results">
        <div className="desk-market-result-head" aria-hidden="true"><span>Market</span><span>Setup</span><span>Return</span><span>Rel. volume</span></div>
        <ul aria-label="Screen candidates" className="desk-market-result-list">{screen.researchShortlist.map(row =>
            <li className="desk-market-result" key={row.instrumentId}>
                <div className="desk-market-result-symbol">
                    <strong>{row.symbol}</strong>
                    {row.direction && <span className="desk-market-side" data-tone={row.direction === "long" ? "up" : "down"}>{row.direction}</span>}
                </div>
                <div className="desk-market-result-setup"><strong>{viewLabels[row.view] ?? row.view}</strong><p>{row.reason}</p>
                    {row.catalyst && <p>{row.catalyst.summary}</p>}
                </div>
                <dl className="desk-market-result-metrics">
                    <div><dt>Return</dt><dd data-tone={tone(row.values.returnBps)}>{change(row.values.returnBps)}</dd></div>
                    <div><dt>Rel. volume</dt><dd>{row.values.relativeVolume == null ? "—" : num(row.values.relativeVolume) + "×"}</dd></div>
                </dl>
            </li>)}</ul>
    </div>;
}

async function json<T>(response: Response): Promise<T> {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Market data could not be read.");
    return body;
}

export function DeskMarketContext({ book }: { book: Book }) {
    const [review, setReview] = useState("");
    const [preset, setPreset] = useState<ScreenQuery["preset"]>("balanced");
    const [timeframe, setTimeframe] = useState<ScreenQuery["timeframe"]>("1h");
    const [direction, setDirection] = useState<ScreenQuery["direction"]>("both");
    const [data, setData] = useState<ContextResponse | null>(null);
    const [screen, setScreen] = useState<ScreenResult | null>(null);
    const [contextError, setContextError] = useState("");
    const [screenError, setScreenError] = useState("");
    const [page, setPage] = useState<{ cursor: string; previous: string[] }>({ cursor: "", previous: [] });
    const [refresh, setRefresh] = useState(0);
    const params = new URLSearchParams({ bookId: book.id, network: book.isTestnet ? "testnet" : "mainnet" });
    if (review) params.set("snapshotId", review);
    const query = params.toString();
    const current = data && (data.context.evidenceId ?? "") === review ? data.context : null;

    useEffect(() => {
        if (review || page.cursor) return;
        const timer = setInterval(() => setRefresh(value => value + 1), 60_000);
        return () => clearInterval(timer);
    }, [review, page.cursor]);

    useEffect(() => {
        const stop = new AbortController();
        fetch("/api/desk/market-context?" + query, { signal: stop.signal }).then(json<ContextResponse>)
            .then(result => { if (!stop.signal.aborted) { setData(result); setContextError(""); } })
            .catch(error => { if (!stop.signal.aborted) setContextError(error.message); });
        return () => stop.abort();
    }, [query, refresh]);

    useEffect(() => {
        const stop = new AbortController();
        fetch("/api/desk/screen?" + query, { method: "POST", signal: stop.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset, timeframe, direction, ...(page.cursor ? { cursor: page.cursor } : {}) }),
        }).then(json<ScreenResult>)
            .then(result => { if (!stop.signal.aborted) { setScreen(result); setScreenError(""); } })
            .catch(error => { if (!stop.signal.aborted) { setScreen(null); setScreenError(error.message); } });
        return () => stop.abort();
    }, [query, preset, timeframe, direction, page.cursor, refresh]);

    function resetScreen() {
        setPage({ cursor: "", previous: [] });
        setScreen(null);
        setScreenError("");
    }

    const observed = current?.marketObservedAt;
    const freshness = current?.status === "observed" ? "Current" : current ? statusLabel(current.status) : "Loading";
    const refreshing = !current && !contextError;
    const screenUnavailable = screen?.status === "stale" || screen?.status === "unavailable";

    return <div className="desk-market">
        <div className="desk-market-toolbar">
            <div className="desk-market-status">
                <span className="desk-market-status-dot" data-status={current?.status ?? "loading"} aria-hidden="true" />
                <strong>{review && current?.status === "observed" ? "Recorded review" : freshness}</strong>
                {observed && <time dateTime={observed}>{timestamp(observed)}</time>}
                {current?.mode === "shadow" && <span className="desk-market-mode" title="The revised screener runs alongside the current candidate feed.">Shadow mode</span>}
            </div>
            <div className="desk-market-toolbar-actions">
                <label className="desk-market-snapshot"><span className="sr-only">Market snapshot</span>
                    <select value={review} onChange={event => { setReview(event.target.value); setContextError(""); resetScreen(); }}>
                        <option value="">Current market</option>
                        {data?.reviews.map(item => <option key={item.evidenceId} value={item.evidenceId}>{timestamp(item.recordedAt)} · Review {item.shiftId.slice(0, 8)}</option>)}
                    </select>
                </label>
                <button type="button" className="desk-market-refresh" aria-label="Refresh market context" title="Refresh market context"
                    onClick={() => { resetScreen(); setRefresh(value => value + 1); }}>
                    <RefreshCw size={15} aria-hidden="true" />
                </button>
            </div>
        </div>
        {contextError && <p className="desk-market-error" role="alert">{contextError}</p>}
        {refreshing && <p className="desk-market-empty" role="status">Loading market context…</p>}
        {current && <>
            {current.status !== "observed" && <p className="desk-market-notice" role="status">
                {current.status === "stale" ? "The last market snapshot is stale." : "Market measurements are unavailable."}
            </p>}
            <MarketOverview context={current} />
        </>}
        <div className="desk-market-workspace">
            <section className="desk-market-surface" aria-label="Market screener">
                <header className="desk-market-section-heading">
                    <h3><ListFilter size={16} aria-hidden="true" /> Screener</h3>
                    {screen && !screenUnavailable && <span>{screen.totalMatches} {screen.totalMatches === 1 ? "match" : "matches"}</span>}
                </header>
                <div className="desk-market-filters">
                    <label>View <select value={preset} onChange={event => { setPreset(event.target.value as ScreenQuery["preset"]); resetScreen(); }}>
                        {views.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select></label>
                    <label>Timeframe <select value={timeframe} onChange={event => { setTimeframe(event.target.value as ScreenQuery["timeframe"]); resetScreen(); }}>
                        {["15m", "1h", "4h"].map(value => <option key={value}>{value}</option>)}
                    </select></label>
                    <label>Direction <select value={direction} onChange={event => { setDirection(event.target.value as ScreenQuery["direction"]); resetScreen(); }}>
                        <option value="both">Both</option><option value="long">Long</option><option value="short">Short</option>
                    </select></label>
                </div>
                {screenError && <p className="desk-market-error" role="alert">{screenError}</p>}
                {!screen && !screenError && <p className="desk-market-empty" role="status">Loading candidates…</p>}
                {screen && <>
                    {screenUnavailable ? <p className="desk-market-empty" role="status">Screen data is {screen.status}.</p> :
                        screen.researchShortlist.length ? <ScreenRows screen={screen} /> :
                        <p className="desk-market-empty">{preset !== "catalyst" && !screen.coverage.structural
                            ? "Complete " + timeframe + " candle structure is unavailable. Try another timeframe."
                            : "No candidates match these filters."}</p>}
                    <footer className="desk-market-screen-footer">
                        <span>{screen.coverage.structural}/{screen.coverage.eligible} with complete {timeframe} structure</span>
                        {(page.previous.length > 0 || screen.nextCursor) && <div aria-label="Screen pages" role="group">
                            <button type="button" aria-label="Previous page" disabled={!page.previous.length} onClick={() => {
                                setScreen(null);
                                setPage(value => ({ cursor: value.previous.at(-1) ?? "", previous: value.previous.slice(0, -1) }));
                            }}><ChevronLeft size={16} aria-hidden="true" /></button>
                            <span>{page.previous.length + 1}</span>
                            <button type="button" aria-label="Next page" disabled={!screen.nextCursor} onClick={() => {
                                const cursor = screen.nextCursor;
                                if (!cursor) return;
                                setScreen(null);
                                setPage(value => ({ cursor, previous: [...value.previous, value.cursor] }));
                            }}><ChevronRight size={16} aria-hidden="true" /></button>
                        </div>}
                    </footer>
                </>}
                {current?.coverage.candleError && <p className="desk-market-notice" role="status">{current.coverage.candleError}</p>}
            </section>
            <MarketEvents key={review} context={current} />
        </div>
    </div>;
}
