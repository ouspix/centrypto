"use client";
import type { ReactNode } from "react";
import { DeskUsage } from "./DeskUsage";
import { roleMandates, type DeskRole } from "@/lib/desk/roles";
import { dateTime, dollars, field, readData, type Overview, type Action } from "./desk-view";

function Table({
    title,
    headers,
    rows,
    empty,
}: {
    title: string;
    headers: string[];
    rows: { id: string; cells: ReactNode[] }[];
    empty: string;
}) {
    return (
        <section className="desk-card">
            <h2>{title}</h2>
            {!rows.length ? (
                <p className="desk-muted">{empty}</p>
            ) : (
                <div className="desk-scroll">
                    <table aria-label={title}>
                        <thead>
                            <tr>
                                {headers.map((h) => (
                                    <th scope="col" key={h}>
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.id}>
                                    {r.cells.map((c, i) => (
                                        <td key={headers[i]}>{c}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

export function DeskBlotter({ data, act, busy }: { data: Overview; act: Action; busy: boolean }) {
    const state = data.state;
    const metrics = state?.metrics;
    const intents = new Map((state?.intents ?? []).map((i) => [i.id, i]));
    return (
        <div className="desk-stack">
            <section className="desk-statbar" aria-label="Book performance">
                {[
                    ["Net P&L", metrics?.netPnlUsd],
                    ["Today", metrics?.dailyPnlUsd],
                    ["Unrealized", metrics?.unrealizedUsd],
                    ["Max drawdown", metrics?.drawdownUsd],
                ].map(([label, n]) => (
                    <div key={label}>
                        <span>{label}</span>
                        <strong>{dollars(typeof n === "number" ? n : null)}</strong>
                    </div>
                ))}
            </section>
            {data.book && <DeskUsage key={data.book.id} bookId={data.book.id}/>}
            <Table
                title="Inventory"
                headers={["Instrument", "Quantity", "Basis", "Realized", "Funding", "Ownership"]}
                empty="No desk inventory recorded."
                rows={(state?.inventory ?? []).map((i) => ({
                    id: i.id,
                    cells: [
                        i.instrumentId,
                        i.quantity,
                        dollars(i.basis),
                        dollars(i.realizedUsd),
                        dollars(i.fundingUsd),
                        i.suspended ? "Suspended · " + (i.reason ?? "check ownership") : "Desk",
                    ],
                }))}
            />
            <Table
                title="Orders"
                headers={["Instrument", "Side", "Filled / total", "Limit", "Status", "Originating thesis"]}
                empty="No orders recorded."
                rows={(state?.intents ?? []).map((i) => {
                    const r = readData(i.requestJson);
                    return {
                        id: i.id,
                        cells: [
                            i.instrumentId,
                            i.side,
                            `${i.filledQty} / ${i.quantity}`,
                            i.limitPrice,
                            <div key="order-state">
                                {[i.state, i.reason].filter(Boolean).join(" · ")}
                                {i.state === "unknown" && (
                                    <button
                                        type="button"
                                        disabled={busy}
                                        title="Verify absence at the exchange before releasing the reservation"
                                        onClick={() =>
                                            void act({
                                                action: "reconcile_unknown",
                                                bookId: data.book?.id,
                                                intentId: i.id,
                                            })
                                        }
                                    >
                                        Resolve unknown order
                                    </button>
                                )}
                            </div>,
                            [field(r, "thesis"), field(r, "eventId")].filter(Boolean).join(" · ") || "—",
                        ],
                    };
                })}
            />
            <Table
                title="Fills and funding"
                headers={[
                    "Time",
                    "Instrument",
                    "Type",
                    "Size @ price",
                    "Fees",
                    "Net realized",
                    "Shortfall",
                    "Attribution",
                ]}
                empty="No fills or funding payments recorded."
                rows={(state?.fills ?? []).map((f) => {
                    const intent = f.intentId ? intents.get(f.intentId) : null,
                        r = readData(intent?.requestJson);
                    return {
                        id: f.id,
                        cells: [
                            dateTime(f.occurredAt),
                            f.instrumentId,
                            f.kind,
                            `${f.quantity} @ ${f.price}`,
                            dollars(f.feeUsd),
                            dollars(f.pnlUsd),
                            dollars(f.shortfallUsd),
                            [field(r, "thesis"), field(r, "eventId")].filter(Boolean).join(" · ") ||
                                f.intentId ||
                                "Funding",
                        ],
                    };
                })}
            />
            <Table
                title="Paired trades"
                headers={["Plan", "Status", "Leg deadline", "Recovery"]}
                empty="No paired trade plans."
                rows={(state?.pairs ?? []).map((p) => ({
                    id: p.id,
                    cells: [p.intentKey, p.state, dateTime(p.deadline), p.reason ?? "—"],
                }))}
            />
            {data.book?.kind === "quoting" && (
                <section className="desk-card">
                    <h2>Quoting mandate</h2>
                    <p>{metrics?.quoteJson ? "Authorized" : "No active quote grant"}</p>
                    {metrics?.quoteJson && <DataFields value={readData(metrics.quoteJson)} />}
                    <p>
                        Last quoted {dateTime(metrics?.lastQuotedAt)} · Exchange cancellation deadline{" "}
                        {dateTime(metrics?.cancelAt)}
                    </p>
                </section>
            )}
            <p className="desk-muted">Exchange reconciliation {dateTime(metrics?.lastSync)}</p>
            {metrics?.lastError && <p role="alert">{metrics.lastError}</p>}
        </div>
    );
}

function DataFields({ value }: { value: Record<string, unknown> }) {
    return (
        <dl className="desk-fields">
            {Object.entries(value).map(([k, v]) => (
                <div key={k}>
                    <dt>{k}</dt>
                    <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                </div>
            ))}
        </dl>
    );
}

export function DeskJournal({ data }: { data: Overview }) {
    const discussion = data.records.filter((r) => ["message", "note", "thesis", "consult"].includes(r.kind));
    const audit = data.records.filter((r) => !discussion.includes(r));
    return (
        <div className="desk-stack">
            <section className="desk-card">
                <h2>Roundtable and instructions</h2>
                {!discussion.length && <p className="desk-muted">No discussion recorded.</p>}
                {discussion.map((r) => {
                    const d = readData(r.dataJson);
                    const role = roleMandates[r.role as DeskRole]?.title ?? r.role;
                    return (
                        <article className="desk-entry" key={r.id}>
                            <header>
                                <strong>{role}</strong>
                                <time>{dateTime(r.createdAt)}</time>
                            </header>
                            {r.kind === "message" && (
                                <small>{d.mode === "live" ? "Trading instruction" : "Research request"}</small>
                            )}
                            <p>
                                {field(d, "summary") ||
                                    field(d, "message") ||
                                    field(d, "thesis") ||
                                    field(d, "question")}
                            </p>
                            {d.summary && d.thesis ? (
                                <p>
                                    <b>Thesis</b> {field(d, "thesis")}
                                </p>
                            ) : null}
                            {field(d, "invalidation") && (
                                <p>
                                    <b>Invalidation</b> {field(d, "invalidation")}
                                </p>
                            )}
                            {field(d, "dissent") && (
                                <p className="desk-dissent">
                                    <b>Dissent</b> {field(d, "dissent")}
                                </p>
                            )}
                            {Array.isArray(d.evidenceIds) && d.evidenceIds.length > 0 && (
                                <small>Evidence {d.evidenceIds.join(" · ")}</small>
                            )}
                            {field(d, "followUpAt") && <small>Review {dateTime(field(d, "followUpAt"))}</small>}
                        </article>
                    );
                })}
            </section>
            <section className="desk-card">
                <h2>Watches and passed opportunities</h2>
                {!data.watches.length && <p className="desk-muted">No watches or passes.</p>}
                {data.watches.map((w) => (
                    <article key={w.id} className="desk-entry">
                        <strong>
                            {w.kind} · {w.instrumentId ?? "Portfolio"} · {w.status}
                        </strong>
                        <p>{w.thesis}</p>
                        <small>
                            Review {dateTime(w.deadline)}
                            {w.referencePrice != null && ` · First executable ${w.referencePrice}`}
                            {w.threshold != null && ` · Trigger ${w.threshold}`}
                        </small>
                        {w.eventKey && <small>Event {w.eventKey}</small>}
                        {w.outcomeJson && <DataFields value={readData(w.outcomeJson)} />}
                    </article>
                ))}
            </section>
            <section className="desk-card">
                <h2>Shifts</h2>
                {!data.shifts.length && <p className="desk-muted">No shifts recorded.</p>}
                {data.shifts.map((s) => (
                    <details key={s.id}>
                        <summary>
                            {dateTime(s.createdAt)} · {s.mode} · {s.status}
                        </summary>
                        {s.error && <p>{s.error}</p>}
                        <DataFields value={readData(s.briefJson)} />
                    </details>
                ))}
            </section>
            <section className="desk-card">
                <h2>Tools and control history</h2>
                {!audit.length && <p className="desk-muted">No tool calls or control changes.</p>}
                {audit.map((r) => {
                    const d = readData(r.dataJson);
                    return (
                        <details key={r.id}>
                            <summary>
                                {dateTime(r.createdAt)} · {r.role} · {r.kind} {field(d, "name")}
                            </summary>
                            <DataFields value={d} />
                        </details>
                    );
                })}
            </section>
        </div>
    );
}
