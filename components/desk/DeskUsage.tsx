"use client";
import { useEffect, useState } from "react";
import type { BookUsage } from "@/lib/desk/token-usage";

const fmt = (n: string) => BigInt(n).toLocaleString();
const dateLocal = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { timeZone: "Europe/Paris", timeZoneName: "short" });
const kinds: Record<string, string> = {
    role: "Desk roles",
    consult: "Consultations",
    "public-search": "Public searches",
    "public-read": "Public source reads",
    probe: "Capability checks",
};

export function DeskUsage({ bookId }: { bookId: string }) {
    const [day, setDay] = useState(""),
        [lifetime, setLifetime] = useState(false),
        [usage, setUsage] = useState<BookUsage | null>(null),
        [error, setError] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        let inFlight = false;
        setUsage(null);
        setError("");
        const read = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                const params = new URLSearchParams({ bookId });
                if (day) params.set("day", day);
                const res = await fetch("/api/desk/usage?" + params, { signal: controller.signal, cache: "no-store" });
                const next = await res.json();
                if (!res.ok) throw new Error(next.error || "Usage unavailable.");
                if (!controller.signal.aborted) {
                    setUsage(next);
                    setError("");
                }
            } catch (e) {
                if (!controller.signal.aborted) {
                    setUsage(null);
                    setError(e instanceof Error ? e.message : "Usage unavailable.");
                }
            } finally {
                inFlight = false;
            }
        };
        void read();
        const timer = setInterval(read, 30000);
        return () => {
            controller.abort();
            clearInterval(timer);
        };
    }, [bookId, day]);
    const s = usage && (lifetime ? usage.allTime : usage.period);
    const beforeMeter = !!(usage && !lifetime && usage.installedAt && usage.end <= usage.installedAt);
    const partial = !!(
        usage &&
        !lifetime &&
        usage.installedAt &&
        usage.start < usage.installedAt &&
        usage.end > usage.installedAt
    );
    return (
        <section className="desk-card desk-stack" aria-label="Sol token usage">
            <div className="desk-toolbar">
                <div>
                    <h2>Sol token usage</h2>
                    <small>Local desk · gpt-6.1-sol</small>
                </div>
                <div className="desk-tabs">
                    <button type="button" aria-pressed={!lifetime} onClick={() => setLifetime(false)}>
                        Day
                    </button>
                    <button type="button" aria-pressed={lifetime} onClick={() => setLifetime(true)}>
                        All recorded
                    </button>
                </div>
            </div>
            {!lifetime && (
                <div className="desk-toolbar">
                    <label>
                        Usage date (Paris)
                        <input type="date" value={day || usage?.day || ""} onChange={(e) => setDay(e.target.value)} />
                    </label>
                    <button type="button" onClick={() => setDay("")} disabled={!day}>
                        Today
                    </button>
                </div>
            )}
            {error ? (
                <p role="status">{error}</p>
            ) : usage && s ? (
                <>
                    <p>
                        {lifetime
                            ? `Recorded since ${usage.installedAt ? dateLocal(usage.installedAt) : "meter installation"}`
                            : `Turns started ${dateLocal(usage.start)} up to ${dateLocal(usage.end)} (exclusive)`}
                    </p>
                    {beforeMeter ? (
                        <p>Token consumption is unknown for this date. The desk meter was installed later.</p>
                    ) : (
                        <>
                            {partial && (
                                <p className="desk-dissent">
                                    Partial day. Recording started at {dateLocal(usage.installedAt!)}.
                                </p>
                            )}
                            <div className="desk-statbar">
                                {[
                                    ["Recorded tokens", s.counts.totalTokens],
                                    ["Input", s.counts.inputTokens],
                                    ["Output", s.counts.outputTokens],
                                ].map(([label, n]) => (
                                    <div key={label}>
                                        <span>{label}</span>
                                        <strong>{fmt(n)}</strong>
                                    </div>
                                ))}
                            </div>
                            <p className="desk-muted">
                                Input includes {fmt(s.counts.cachedInputTokens)} cached and{" "}
                                {fmt(s.counts.cacheWriteInputTokens)} cache-write tokens. Output includes{" "}
                                {fmt(s.counts.reasoningOutputTokens)} reasoning tokens.
                            </p>
                            <p>
                                {s.reported} of {s.attempts} model attempts reported usage · {s.unfinished} unfinished ·{" "}
                                {s.failed} failed or cancelled
                            </p>
                            {(s.missing > 0 || s.unfinished > 0 || s.failed > 0) && (
                                <p className="desk-dissent">
                                    Counts include the last reported usage for interrupted attempts. {s.missing}{" "}
                                    {s.missing === 1 ? "attempt has" : "attempts have"} no token report.
                                </p>
                            )}
                            {!!s.byKind.length && (
                                <dl className="desk-fields">
                                    {s.byKind.map((row) => (
                                        <div key={row.kind}>
                                            <dt>{kinds[row.kind] ?? row.kind}</dt>
                                            <dd>
                                                {fmt(row.totalTokens)} tokens · {row.attempts} attempts
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            )}
                            {!!s.byRole.length && (
                                <details>
                                    <summary>Recorded tokens by role</summary>
                                    <dl className="desk-fields">
                                        {s.byRole.map((row) => (
                                            <div key={row.role}>
                                                <dt>{row.role}</dt>
                                                <dd>{fmt(row.totalTokens)}</dd>
                                            </div>
                                        ))}
                                    </dl>
                                </details>
                            )}
                        </>
                    )}
                    <small className="desk-muted">
                        Usage before metering is unavailable.
                        {usage.priorShifts != null && usage.priorShifts > 0
                            ? ` ${usage.priorShifts} shift(s) started before metering.`
                            : ""}{" "}
                        Excludes Luna, other books, and Codex activity outside this desk.
                    </small>
                </>
            ) : (
                <p className="desk-muted">Loading recorded usage…</p>
            )}
        </section>
    );
}
