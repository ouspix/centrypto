"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTrading } from "@/context/TradingContext";
import type { CollectorSource, NewsAdapter, NewsContext, NewsSignal } from "@/types/news";
import { NEWS_ADAPTERS } from "@/types/news";
import { Activity, ChevronDown, ExternalLink, Loader2, Newspaper } from "lucide-react";

type Source = CollectorSource & { status: string; lastSuccessAt: string | null; lastError: string | null };
type Evidence = { id: string; canonicalUrl: string; author: string | null; publishedAt: string | null; collectedAt: string; text: string; source: { name: string; isPrivate: boolean } };
const emptySource = { name: "", adapter: "x" as NewsAdapter, url: "", isPrivate: false, enabled: true, priority: 0, intervalSeconds: 300 };
const directionStyles = {
    bullish: "bg-emerald-400/10 text-emerald-300",
    bearish: "bg-rose-400/10 text-rose-300",
    mixed: "bg-amber-400/10 text-amber-200",
    neutral: "bg-slate-700/50 text-slate-300"
};
const claimLabels = { confirmed_announcement: "Announcement", reported_claim: "Reported", rumor: "Rumor", opinion: "Opinion" };

export function NewsIntelligencePanel() {
    const { selectedPair, walletSessionAddress } = useTrading();
    const activeWallet = useRef(walletSessionAddress);
    activeWallet.current = walletSessionAddress;
    const activePair = useRef(selectedPair);
    activePair.current = selectedPair;
    const [briefing, setBriefing] = useState<NewsContext | null>(null);
    const [sources, setSources] = useState<Source[]>([]);
    const [events, setEvents] = useState<NewsSignal[]>([]);
    const [evidence, setEvidence] = useState<Evidence[]>([]);
    const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
    const [evidenceLoading, setEvidenceLoading] = useState(false);
    const evidenceRequest = useRef(0);
    const [showSources, setShowSources] = useState(false);
    const [draft, setDraft] = useState(emptySource);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [codexStatus, setCodexStatus] = useState("Checking local worker…");
    const [rolloutStatus, setRolloutStatus] = useState("");
    const [retentionNotice, setRetentionNotice] = useState("");

    const refresh = useCallback(async (signal?: AbortSignal) => {
        if (!walletSessionAddress) return;
        const symbol = selectedPair.replace(/-PERP$/, "");
        const [briefingResponse, sourceResponse, eventResponse, healthResponse] = await Promise.all([
            fetch(`/api/news/briefing?symbol=${encodeURIComponent(symbol)}`, { signal }), fetch("/api/news/sources", { signal }), fetch("/api/news/events", { signal }), fetch("/api/news/collector", { signal })
        ]);
        if (![briefingResponse, sourceResponse, eventResponse, healthResponse].every(response => response.ok)) throw new Error("News intelligence could not be loaded. Check your wallet session and database connection.");
        const [nextBriefing, nextSources, nextEvents, health] = await Promise.all([briefingResponse.json(), sourceResponse.json(), eventResponse.json(), healthResponse.json()]);
        if (activeWallet.current !== walletSessionAddress || activePair.current !== selectedPair) return;
        setBriefing(nextBriefing);
        setSources(nextSources.sources);
        setEvents(nextEvents.events.filter((event: NewsSignal) => !event.symbols.length || event.symbols.includes(symbol)).slice(0, 10));
        const modelError = health.codex.models["gpt-6-luna"]?.error;
        setCodexStatus(health.codex.backoffUntil && new Date(health.codex.backoffUntil) > new Date() ? "Local Codex allowance is cooling down; evidence remains queued" : modelError === "authentication" ? "Sign in to Codex on this PC to resume Luna analysis" : modelError === "model_unavailable" ? "GPT-6 Luna access is unavailable for this Codex account" : health.codex.available && health.codex.models["gpt-6-luna"]?.available ? "Local Luna worker available" : "Local Luna worker unavailable; collected evidence remains queued");
        const collectorHealth = health.collectors.map((collector: { healthJson: string }) => { try { return JSON.parse(collector.healthJson); } catch { return {}; } });
        if (health.contextMode === "healthy") {
            setRolloutStatus("Trading uses current signals whose cited sources are all healthy.");
        } else if (health.contextMode === "false") {
            setRolloutStatus("News context is disabled for trading");
        } else {
            const observed = collectorHealth.length > 0 && collectorHealth.every((item: { observation?: { ready: boolean; checkedAt: string } }) => item.observation?.ready && Date.now() - new Date(item.observation.checkedAt).getTime() < 180_000);
            setRolloutStatus(health.contextMode === "true" || observed ? "News context is available to all trader models" : "Trader context is in observation; it becomes available after 24 hours of healthy collection and analysis");
        }
        const lost = collectorHealth.reduce((sum: number, item: { retention?: { unprocessedRemoved: number } }) => sum + (item.retention?.unprocessedRemoved || 0), 0);
        setRetentionNotice(lost ? `${lost} older unprocessed evidence item(s) expired or exceeded backlog retention. Historical coverage has gaps.` : "");
        setError("");
    }, [selectedPair, walletSessionAddress]);

    useEffect(() => {
        setDraft(emptySource); setEditingId(null); setShowSources(false); setBusy(false);
        setRolloutStatus(""); setRetentionNotice("");
    }, [walletSessionAddress]);

    useEffect(() => {
        setBriefing(null); setSources([]); setEvents([]); setEvidence([]); setError("");
        setEvidenceFor(null); setEvidenceLoading(false); evidenceRequest.current++;
        if (!walletSessionAddress) return;
        const controller = new AbortController();
        const update = () => { void refresh(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }); };
        update();
        const timer = setInterval(update, 30_000);
        return () => { controller.abort(); clearInterval(timer); };
    }, [refresh, walletSessionAddress]);

    const mutate = async (method: string, body?: object, id?: string) => {
        const requestedWallet = walletSessionAddress;
        setBusy(true); setError("");
        try {
            const response = await fetch(`/api/news/sources${id && method === "DELETE" ? `?id=${encodeURIComponent(id)}` : ""}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
            if (!response.ok) throw new Error((await response.json()).error || "Source update failed");
            if (activeWallet.current !== requestedWallet) return;
            setDraft(emptySource);
            setEditingId(null);
            await refresh();
        } catch (reason) { if (activeWallet.current === requestedWallet) setError(reason instanceof Error ? reason.message : "Source update failed"); }
        finally { if (activeWallet.current === requestedWallet) setBusy(false); }
    };

    const inspectEvidence = async (signal: NewsSignal) => {
        const requestedWallet = walletSessionAddress;
        const requestedPair = selectedPair;
        const request = ++evidenceRequest.current;
        const isCurrent = () => activeWallet.current === requestedWallet && activePair.current === requestedPair && evidenceRequest.current === request;
        setEvidenceFor(signal.eventKey); setEvidence([]); setEvidenceLoading(true); setError("");
        try {
            const response = await fetch(`/api/news/evidence?ids=${signal.evidenceIds.map(encodeURIComponent).join(",")}`);
            if (!response.ok) throw new Error("Evidence is unavailable or expired");
            const items = (await response.json()).evidence;
            if (!isCurrent()) return;
            if (!items.length) throw new Error("Evidence has expired or is unavailable");
            setEvidence(items);
        } catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : "Evidence unavailable"); }
        finally { if (isCurrent()) setEvidenceLoading(false); }
    };

    return <section className="min-w-0 self-start overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-slate-100" aria-label="News intelligence">
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-4">
            <div className="flex min-w-0 items-center gap-3">
                <span className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-2 text-sky-300"><Newspaper aria-hidden="true" className="h-4 w-4" /></span>
                <div>
                    <h2 className="text-sm font-semibold">News intelligence <span className="ml-1 text-slate-500">· {selectedPair.replace(/-PERP$/, "")}</span></h2>
                    <p className="mt-0.5 text-xs text-slate-400">AI summaries of collected news</p>
                </div>
            </div>
            <button type="button" onClick={() => setShowSources(value => !value)} aria-expanded={showSources} className="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 hover:text-white disabled:opacity-50" disabled={!walletSessionAddress}>Sources</button>
        </div>
        {!walletSessionAddress ? <p className="p-4 text-sm text-slate-300">Verify your wallet session to view private news intelligence and configure collection.</p> : <div>
            <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3 text-xs text-slate-400">
                <span className="flex items-center gap-2">
                    <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${briefing?.status === "healthy" ? "bg-emerald-400" : "bg-amber-400"}`} />
                    {briefing ? `${briefing.coverage.healthy}/${briefing.coverage.configured} sources healthy · ${briefing.coverage.pendingDocuments} awaiting analysis` : "Loading news…"}
                </span>
                {briefing?.availableAt && <time dateTime={briefing.availableAt} title={new Date(briefing.availableAt).toLocaleString()}>Updated {new Date(briefing.availableAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
            </div>
            <div className="space-y-3 px-4 pt-3">
            {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
                {briefing?.status === "incomplete" && <button type="button" onClick={() => setShowSources(true)} className="text-xs text-amber-300 hover:underline">Coverage is incomplete · Review sources</button>}
                {!!briefing?.coverage.rejectedDocuments && <p className="text-amber-300">Analysis is unavailable for {briefing.coverage.rejectedDocuments} evidence item(s): model output failed validation. <button type="button" disabled={busy} className="underline" onClick={() => { setBusy(true); void fetch('/api/news/analysis/retry', { method: 'POST' }).then(response => { if (!response.ok) throw new Error('Could not retry analysis'); return refresh(); }).catch(reason => setError(reason.message)).finally(() => setBusy(false)); }}>Retry analysis</button></p>}
            </div>
            {briefing?.signals.length === 0 && <div className="px-4 py-5 text-sm leading-relaxed text-slate-300">
                <p>No active AI summaries for this asset.</p>
                <p className="mt-2 text-xs text-slate-400">{briefing.summary}</p>
            </div>}
            <ol className="max-h-[420px] space-y-2 overflow-y-auto overscroll-contain px-4 py-3" aria-label="News event timeline">
                {(briefing?.signals || []).map((signal, index) => <li key={`${signal.eventKey}-${index}`}>
                    <details className="group rounded-lg border border-slate-700/60 bg-slate-950/40 transition hover:border-slate-600">
                        <summary className="cursor-pointer list-none rounded-lg p-3 outline-none focus-visible:ring-2 focus-visible:ring-sky-400 [&::-webkit-details-marker]:hidden">
                            <div className="flex flex-wrap items-center gap-2 text-[11px]">
                                <span className={`rounded px-1.5 py-0.5 font-medium capitalize ${directionStyles[signal.direction]}`}>{signal.direction}</span>
                                <span className="text-slate-400">{claimLabels[signal.claimType]}</span>
                                <span className="ml-auto max-w-[55%] truncate font-mono text-slate-500" title={signal.symbols.join(", ")}>{signal.symbols.length ? signal.symbols.join(" · ") : "Broad market"}</span>
                            </div>
                            <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-slate-200 group-open:line-clamp-none">{signal.summary}</p>
                            <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                                <span>AI summary · {signal.evidenceIds.length} reference{signal.evidenceIds.length === 1 ? "" : "s"}</span>
                                <span className="flex items-center gap-1 text-sky-300">Details & sources<ChevronDown aria-hidden="true" className="h-3 w-3 transition group-open:rotate-180" /></span>
                            </div>
                        </summary>
                        <div className="space-y-3 border-t border-slate-800 px-3 py-3">
                            <p className="text-xs leading-relaxed text-slate-400">{signal.corroboration}</p>
                            {signal.contradictions.length > 0 && <p className="text-xs leading-relaxed text-amber-200">Uncertainty — {signal.contradictions.join(" ")}</p>}
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                                <span>AI confidence {Math.round(signal.confidence * 100)}%</span>
                                <span>Materiality {Math.round(signal.materiality * 100)}%</span>
                                <span>{signal.horizon.replace(/_/g, " ")}</span>
                                <span>{signal.category.replace(/_/g, " ")}</span>
                            </div>
                            <button type="button" onClick={() => { void inspectEvidence(signal); }} disabled={evidenceLoading && evidenceFor === signal.eventKey} className="flex items-center gap-1.5 text-xs font-medium text-sky-300 hover:text-sky-200 disabled:opacity-50">
                                {evidenceLoading && evidenceFor === signal.eventKey ? <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> : <Newspaper aria-hidden="true" className="h-3 w-3" />}Read original sources
                            </button>
                            {evidenceFor === signal.eventKey && evidence.length > 0 && <div className="space-y-3" aria-label="Original source text">{evidence.map(item => <article key={item.id} className="rounded-md border border-slate-700 bg-slate-900 p-3">
                                <a href={item.canonicalUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs font-medium text-sky-300 hover:underline">{item.source.name}{item.source.isPrivate ? " · private" : ""}<ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" /></a>
                                <p className="mt-1 text-[11px] text-slate-500">{new Date(item.publishedAt || item.collectedAt).toLocaleString()}{item.author ? ` · ${item.author}` : ""}</p>
                                <p className="mt-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">Collected source text</p>
                                <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-300">{item.text}</p>
                            </article>)}</div>}
                        </div>
                    </details>
                </li>)}
            </ol>
            <div className="space-y-3 border-t border-slate-800 px-4 py-3">
                <details>
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><Activity aria-hidden="true" className="h-3 w-3" />Collection status<ChevronDown aria-hidden="true" className="ml-auto h-3 w-3" /></summary>
                    <div className="mt-3 space-y-2 text-xs leading-relaxed text-slate-400">
                        <p>{codexStatus}</p><p>{rolloutStatus}</p>
                        {retentionNotice && <p className="text-amber-300">{retentionNotice}</p>}
                        {briefing?.summary && <div className="border-t border-slate-800 pt-2"><p className="mb-1 font-medium text-slate-300">Latest batch summary · AI generated</p><p>{briefing.summary}</p></div>}
                    </div>
                </details>
                {events.length > 0 && <details><summary className="cursor-pointer text-xs text-slate-400">Recent event history</summary><ul className="mt-2 max-h-60 space-y-2 overflow-y-auto">{events.map((event, index) => <li className="text-xs leading-relaxed text-slate-400" key={`${event.eventKey}-${index}`}>{event.summary}{new Date(event.expiresAt) < new Date() ? " (expired)" : ""}</li>)}</ul></details>}
            </div>
            {showSources && <div className="space-y-3 border-t border-slate-700 p-4">
                <h3 className="font-medium">Automatic source registry</h3>
                <button type="button" disabled={busy} className="text-sm text-sky-300 underline" onClick={() => { setBusy(true); void fetch('/api/news/sources/seed', { method: 'POST' }).then(response => { if (!response.ok) throw new Error('Could not add default news feeds'); return refresh(); }).catch(reason => setError(reason.message)).finally(() => setBusy(false)); }}>Add standard public news feeds</button>
                <a className="ml-3 text-sm text-sky-300 underline" href="http://localhost:6089/vnc.html?autoconnect=1&resize=scale" target="_blank" rel="noopener noreferrer">Open remote browser</a>
                <p className="text-xs text-slate-300">Use specific Discord/Telegram channels. Sign in through the remote browser, then resume the source. DMs are excluded.</p>
                <ul className="space-y-2">{sources.map(source => <li key={source.id} className="space-y-1 text-sm">
                    <p className="break-words">{source.name} · {source.enabled ? source.status : "disabled"} · every {source.intervalSeconds / 60} min{source.isPrivate ? " · private" : ""}</p>
                    <div className="flex flex-wrap gap-3"><button type="button" disabled={busy} onClick={() => { setEditingId(source.id); setDraft({ name: source.name, adapter: source.adapter, url: source.url, isPrivate: source.isPrivate, enabled: source.enabled, priority: source.priority, intervalSeconds: source.intervalSeconds }); }} className="text-sky-300 underline">Edit</button><button type="button" disabled={busy} onClick={() => { void mutate("PUT", { ...source, enabled: true }); }} className="text-sky-300 underline">Resume</button><button type="button" disabled={busy} onClick={() => { void mutate("PUT", { ...source, enabled: false }); }} className="text-slate-300 underline">Pause</button><button type="button" disabled={busy} onClick={() => { if (window.confirm("Remove this source and its stored evidence? Derived briefings will be rebuilt.")) void mutate("DELETE", undefined, source.id); }} className="text-amber-300 underline">Remove</button></div>
                </li>)}</ul>
                <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void mutate(editingId ? "PUT" : "POST", { ...draft, ...(editingId ? { id: editingId } : {}) }); }}>
                    <label className="text-sm">Source name<input required maxLength={120} className="mt-1 block w-full rounded border border-slate-600 bg-slate-950 p-2" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
                    <label className="text-sm">Source type<select className="mt-1 block w-full rounded border border-slate-600 bg-slate-950 p-2" value={draft.adapter} onChange={event => setDraft({ ...draft, adapter: event.target.value as NewsAdapter })}>{NEWS_ADAPTERS.map(adapter => <option key={adapter} value={adapter}>{adapter}</option>)}</select></label>
                    <label className="text-sm">Source URL<input required type="url" className="mt-1 block w-full rounded border border-slate-600 bg-slate-950 p-2" placeholder="https://…" value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })} /></label>
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.priority === 1} onChange={event => setDraft({ ...draft, priority: event.target.checked ? 1 : 0 })} />Priority source (1 minute; others 5 minutes)</label>
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.isPrivate} onChange={event => setDraft({ ...draft, isPrivate: event.target.checked })} />Private source</label>
                    <button disabled={busy} type="submit" className="rounded bg-sky-700 px-3 py-2 text-sm disabled:opacity-50">{editingId ? "Save source" : "Add source"}</button>
                    {editingId && <button type="button" onClick={() => { setEditingId(null); setDraft(emptySource); }} className="text-sm underline">Cancel edit</button>}
                </form>
            </div>}
        </div>}
    </section>;
}
