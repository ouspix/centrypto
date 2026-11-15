"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, Check, CirclePause, FileText, Radio, Sparkles } from "lucide-react";
import { deskRoles, type DeskRole } from "@/lib/desk/roles";
import type { AnalystActivity, AnalystState } from "@/lib/desk/activity-types";
import { dateTime, type Book } from "./desk-view";
import { AnalystStation } from "./AnalystStation";
import { useDeskActivity } from "./useDeskActivity";

const roles: Record<DeskRole, { name: string; specialty: string; task: string; description: string }> = {
    catalyst: { name: "Catalyst", specialty: "News & tokens", task: "Investigating the catalyst", description: "Checks original sources, what changed, and whether an event affects the exact token under review." },
    derivatives: { name: "Derivatives", specialty: "Pricing & positioning", task: "Assessing relative value", description: "Looks for pricing opportunities in funding, positioning, and related instruments, after costs." },
    execution: { name: "Execution", specialty: "Liquidity & orders", task: "Checking execution", description: "Checks executable prices, liquidity, and fees, then works orders within the lead’s authority." },
    risk: { name: "Risk", specialty: "Independent challenge", task: "Assessing downside", description: "Challenges ideas on concentration, downside, collateral, and the ability to exit a position." },
    lead: { name: "Lead", specialty: "Portfolio & decisions", task: "Reviewing the book", description: "Brings the team’s findings together and owns the decision to trade, wait, or hold cash." },
};
const stateLabels: Record<AnalystState, string> = {
    waiting: "Waiting", working: "Working", completed: "Report ready",
    interrupted: "Interrupted", failed: "Failed", unconfirmed: "Unconfirmed",
};
const humanTool = (name: string) => name.replaceAll("_", " ");
const toolTasks = new Map([
    ["account_exposure", "Checking account exposure"],
    ["assess_trade_scenarios", "Comparing trade scenarios"],
    ["backtest_status", "Checking backtest results"],
    ["backtest_strategy", "Submitting a backtest"],
    ["funding_and_basis", "Checking funding and basis"],
    ["market_history", "Checking price history"],
    ["order_book", "Checking the order book"],
    ["preview_order", "Previewing an order"],
    ["read_public_source", "Reading a public source"],
    ["screen_markets", "Scanning markets"],
    ["search_news", "Looking up news"],
    ["search_public_sources", "Looking up public sources"],
    ["transaction_cost", "Estimating trading costs"],
]);

function workingMessage(role: DeskRole, turn?: AnalystActivity["invocations"][number]) {
    if (turn?.tool) {
        const { name, market } = turn.tool;
        const task = toolTasks.get(name) ?? "Using " + humanTool(name);
        return market ? `${task} (${market})` : task;
    }
    if (turn?.question) return turn.question;
    if (turn?.requester) return "Reviewing evidence for " + roles[turn.requester].name;
    return roles[role].task;
}

function ActivityIcon({ state }: { state: AnalystState }) {
    if (state === "completed") return <Check size={12} aria-hidden="true" />;
    if (state === "working") return <Radio size={12} aria-hidden="true" />;
    if (state === "interrupted" || state === "failed") return <CirclePause size={12} aria-hidden="true" />;
    return <span className="office-status-dot" aria-hidden="true" />;
}
const floorSpots: Record<DeskRole, [number, number]> = {
    catalyst: [33.3, 25], derivatives: [66.7, 25], execution: [16.7, 75], risk: [83.3, 75], lead: [50, 75],
};
const phoneSpots: Record<DeskRole, [number, number]> = {
    catalyst: [25, 16.7], derivatives: [75, 16.7], execution: [25, 50], risk: [75, 50], lead: [50, 83.3],
};

function ConsultationLinks({ analysts }: { analysts: AnalystActivity[] }) {
    const links = analysts.flatMap(analyst => analyst.invocations.flatMap(turn =>
        analyst.state === "working" && turn.phase === "started" && turn.requester
            ? [{ id: turn.invocationId, from: turn.requester, to: analyst.role }]
            : []));
    if (!links.length) return null;
    return <>{[floorSpots, phoneSpots].map((spots, index) => (
        <svg key={index} className={"office-links " + (index ? "office-links-mobile" : "office-links-wide")}
            viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {links.map(link => {
                const [x, y] = spots[link.from], [toX, toY] = spots[link.to];
                const d = `M ${x} ${y} Q ${(x + toX) / 2} ${(y + toY) / 2 - 8} ${toX} ${toY}`;
                return <g key={link.id} className="office-link-consult">
                    <path d={d} className="office-link-route" vectorEffect="non-scaling-stroke" />
                    <path d={d} className="office-link-packet" pathLength="1" vectorEffect="non-scaling-stroke" />
                </g>;
            })}
        </svg>
    ))}</>;
}

function Inspector({ analyst, fresh, close }: { analyst: AnalystActivity; fresh: boolean; close: () => void }) {
    const profile = roles[analyst.role];
    const note = analyst.finding?.note;
    const active = fresh && analyst.state === "working";
    return (
        <aside className="office-inspector" aria-labelledby="analyst-heading">
            <div className="office-inspector-header"><span className="office-eyebrow">ANALYST DETAILS</span>
                <button type="button" onClick={close} aria-label="Close analyst details">×</button>
            </div>
            <h3 id="analyst-heading" tabIndex={-1}>{profile.name}</h3>
            <p className="office-specialty">{profile.specialty}</p>
            <p className="office-mandate">{profile.description}</p>
            <div className="office-inspector-task">
                <span className="office-eyebrow">CURRENT ACTIVITY</span>
                <strong>{!fresh ? "Activity unconfirmed" : stateLabels[analyst.state]}</strong>
                {analyst.invocations.map(invocation => (
                    <div className="office-turn" key={invocation.invocationId}>
                        <span>{invocation.requester ? "Consulting for " + roles[invocation.requester].name : "Primary review"}</span>
                        {active && invocation.phase === "started" && <p>{workingMessage(analyst.role, invocation)}</p>}
                        <small>{invocation.phase === "started" ? "Started" : invocation.phase} {dateTime(invocation.endedAt ?? invocation.startedAt)}</small>
                        {invocation.error && <p className="office-warning">{invocation.error}</p>}
                    </div>
                ))}
                {!analyst.invocations.length && <p className="desk-muted">No current turn recorded.</p>}
            </div>
            <div className="office-finding">
                <span className="office-eyebrow">LATEST SAVED FINDING</span>
                {note ? (
                    <>
                        <time>{dateTime(analyst.finding?.createdAt)}</time>
                        {analyst.finding?.consultedBy && <p>Consultation for {roles[analyst.finding.consultedBy]?.name ?? analyst.finding.consultedBy}</p>}
                        <p className="office-finding-summary">{note.summary}</p>
                        {note.thesis && <p>{note.thesis}</p>}
                        {note.invalidation && <div><strong>Reconsider if</strong><p>{note.invalidation}</p></div>}
                        {note.dissent && <div className="office-warning"><strong>Dissent</strong><p>{note.dissent}</p></div>}
                        {Array.isArray(note.evidenceIds) && note.evidenceIds.length > 0 &&
                            <div><strong>Evidence IDs</strong><ul className="office-evidence">{note.evidenceIds.map(id => <li key={id}>{id}</li>)}</ul></div>}
                        {note.followUpAt && <p>Review {dateTime(note.followUpAt)}</p>}
                    </>
                ) : <p className="desk-muted">A finding will appear when this analyst commits a report.</p>}
            </div>
        </aside>
    );
}
export function DeskOffice({ book }: { book: Book }) {
    const activity = useDeskActivity(book.id, book.isTestnet);
    const [selected, setSelected] = useState<DeskRole | null>(null);
    const [motion, setMotion] = useState(true);
    const [arrivals, setArrivals] = useState<Partial<Record<DeskRole, number>>>({});
    const seenFindings = useRef<Map<DeskRole, number> | null>(null);
    const data = activity.data;
    useEffect(() => {
        if (!data) return;
        const current = new Map(data.analysts.filter(a => a.finding).map(a => [a.role, a.finding!.id]));
        if (seenFindings.current && activity.fresh) {
            const changed: Partial<Record<DeskRole, number>> = {};
            for (const analyst of data.analysts) {
                const finding = analyst.finding;
                if (finding && finding.shiftId === data.shift?.id && seenFindings.current.get(analyst.role) !== finding.id)
                    changed[analyst.role] = finding.id;
            }
            setArrivals(changed);
        }
        seenFindings.current = current;
    }, [data, activity.fresh]);
    const analysts = deskRoles.map(role => data?.analysts.find(a => a.role === role) ?? {
        role, state: "unconfirmed" as const, invocations: [], finding: null,
    });
    const selectedAnalyst = analysts.find(a => a.role === selected);
    function closeInspector() {
        setSelected(null);
        document.querySelector<HTMLButtonElement>(".office-" + selected)?.focus();
    }
    useEffect(() => {
        if (!selected) return;
        document.getElementById("analyst-heading")?.focus({
            preventScroll: !window.matchMedia("(max-width: 780px)").matches,
        });
        const escape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setSelected(null);
                document.querySelector<HTMLButtonElement>(".office-" + selected)?.focus();
            }
        };
        window.addEventListener("keydown", escape);
        return () => window.removeEventListener("keydown", escape);
    }, [selected]);
    const lead = analysts.find(a => a.role === "lead")?.finding;
    const running = !!data?.shift?.active && activity.fresh;
    const workingCount = analysts.filter(analyst => analyst.state === "working").length;
    const interrupted = data?.shift?.status === "failed" || (running && !workingCount && analysts.some(a => a.state === "failed"));
    const headline = !activity.fresh ? "Awaiting desk update" : interrupted ? "Review interrupted"
        : running ? "Review in progress" : "Between reviews";
    const connection = activity.error ? "Connection interrupted" : !data ? "Connecting to desk"
        : !activity.fresh ? "Updates paused" : !data.workerFresh && (book.enabled || data.shift?.status === "running")
            ? "Worker unconfirmed" : "Desk connected";
    return (
        <section className="office" aria-label="Live analyst office" data-motion={motion && activity.visible && activity.fresh}>
            <div className="office-topline">
                <div className="office-connection" role="status"><span data-live={activity.fresh && data?.workerFresh} />{connection}</div>
                <span className="office-time">{activity.lastSuccess ? "Updated " + new Date(activity.lastSuccess).toLocaleTimeString() : "Waiting for first update"}</span>
                <button type="button" className="office-motion" aria-pressed={motion} onClick={() => setMotion(!motion)}>
                    {motion ? <CirclePause size={14} /> : <Sparkles size={14} />} Motion {motion ? "on" : "off"}
                </button>
            </div>
            {activity.error && <p role="alert" className="office-connection-error">{activity.error} · Last received activity is shown below.</p>}
            <div className="office-layout" data-inspecting={!!selectedAnalyst}>
                <div className="office-room">
                    <div className="office-room-title">
                        <h2>{headline}</h2>
                        <p>{running && workingCount ? workingCount + (workingCount === 1 ? " analyst working" : " analysts working") : "Select a workstation for details"}</p>
                    </div>
                    <div className="office-atmosphere" aria-hidden="true"><i /><i /><i /></div>
                    <div className="office-stations">
                        {activity.fresh && <ConsultationLinks analysts={analysts} />}
                        {analysts.map(analyst => {
                            const profile = roles[analyst.role];
                            const state = !activity.fresh ? "unconfirmed" : analyst.state;
                            const activeTurns = state === "working" ? analyst.invocations.filter(i => i.phase === "started") : [];
                            const turn = activeTurns.find(i => i.tool) ?? activeTurns.find(i => i.question) ?? activeTurns[0];
                            const message = state === "working" ? workingMessage(analyst.role, turn) : null;
                            return (
                                <button type="button" key={analyst.role} className={"office-station office-" + analyst.role}
                                    data-state={state} aria-pressed={selected === analyst.role} aria-expanded={selected === analyst.role}
                                    aria-controls="office-analyst-details" onClick={() => {
                                        setSelected(analyst.role);
                                    }}
                                    aria-label={[profile.name, stateLabels[state], message, "View work"].filter(Boolean).join(" · ")}
                                    title={message ?? undefined}>
                                    <span className="office-station-illustration" aria-hidden="true">
                                        <AnalystStation role={analyst.role} />
                                        {message && <span className="office-thought"><span>{message}</span><i /><i /><i /></span>}
                                        {arrivals[analyst.role] && <span key={arrivals[analyst.role]} className="office-report"><FileText size={14} /></span>}
                                    </span>
                                    <span className="office-nameplate">
                                        <span className="office-station-caption"><strong>{profile.name}</strong>
                                            <span className="office-station-state"><ActivityIcon state={state} />{stateLabels[state]}</span>
                                        </span>
                                        <span className="office-station-task">{turn?.requester ? "Consulting for " + roles[turn.requester].name : profile.specialty}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div id="office-analyst-details" hidden={!selectedAnalyst}>
                    {selectedAnalyst && <Inspector analyst={selectedAnalyst} fresh={activity.fresh} close={closeInspector} />}
                </div>
            </div>
            <div className="office-decision">
                <span className="office-decision-icon"><ArrowDownLeft size={19} aria-hidden="true" /></span>
                <div><span className="office-eyebrow">LATEST LEAD DECISION</span><p>{lead?.note.summary ?? "The lead’s next saved decision will appear here."}</p>
                    {lead && <time>{dateTime(lead.createdAt)}</time>}</div>
                {lead && <button type="button" className="office-read-decision" onClick={() => setSelected("lead")}>Read decision</button>}
            </div>
            <details className="office-recent" aria-label="Recent desk activity">
                <summary>Recent activity</summary>
                {!data?.recent.length && <p className="desk-muted">No desk activity recorded yet.</p>}
                {data?.recent.slice(0, 4).map(event => (
                    <div className="office-recent-item" key={event.id}>
                        <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                        <strong>{roles[event.role as DeskRole]?.name ?? event.role}</strong>
                        <span>{event.kind === "dispatch" ? "Tool dispatched · " : ""}{humanTool(event.label)}</span>
                    </div>
                ))}
            </details>
        </section>
    );
}
