"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, BarChart3, BookOpen, ClipboardList, MessageSquare, Monitor, SlidersHorizontal } from "lucide-react";
import { useTrading } from "@/context/TradingContext";
import { DeskBlotter, DeskJournal } from "./DeskBlotter";
import { CreateDeskBook, DeskControls } from "./DeskControls";
import { DeskOffice } from "./DeskOffice";
import { DeskChat } from "./DeskChat";
import { DeskMarketContext } from "./DeskMarketContext";
import { DeskUsage } from "./DeskUsage";
import { DeskPanelHeader } from "./DeskPanelHeader";
import {
    shortAddress,
    type Action,
    type Book,
    type Overview,
} from "./desk-view";

const deskTools = {
    "Desk simulation": Monitor,
    "Market context": Activity,
    Journal: BookOpen,
    Chat: MessageSquare,
    "Book details": ClipboardList,
    Usage: BarChart3,
    Controls: SlidersHorizontal,
};
type DeskTool = keyof typeof deskTools;
const deskToolNames = Object.keys(deskTools) as DeskTool[];

function DeskSession({ owner, testnet }: { owner: string; testnet: boolean }) {
    const [selectedId, setSelectedId] = useState("");
    const [view, setView] = useState<Overview | null>(null),
        [panel, setPanel] = useState<DeskTool>("Desk simulation");
    const [adding, setAdding] = useState(false),
        [error, setError] = useState(""),
        [operationError, setOperationError] = useState(""),
        [notice, setNotice] = useState(""),
        [busy, setBusy] = useState(false);
    const mounted = useRef(true),
        requestSeq = useRef(0),
        working = useRef(false);
    const read = useRef<AbortController | null>(null),
        write = useRef<AbortController | null>(null);
    const deskToolsNav = useRef<HTMLElement>(null);
    function closePanel() {
        deskToolsNav.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
        setPanel("Desk simulation");
    }
    const refresh = useCallback(async () => {
        const seq = ++requestSeq.current;
        read.current?.abort();
        const controller = new AbortController();
        read.current = controller;
        try {
            const params = new URLSearchParams({ network: testnet ? "testnet" : "mainnet" });
            if (selectedId) params.set("bookId", selectedId);
            const res = await fetch("/api/desk?" + params, { signal: controller.signal, cache: "no-store" });
            const next = await res.json();
            if (controller.signal.aborted || !mounted.current || seq !== requestSeq.current) return;
            if (!res.ok) {
                if (res.status === 401 || res.status === 403 || res.status === 404) setView(null);
                throw new Error(next.error || "Desk could not be loaded.");
            }
            if (
                !Array.isArray(next.books) ||
                next.books.some((b: Book) => b.ownerAddress?.toLowerCase() !== owner || b.isTestnet !== testnet) ||
                (next.book &&
                    (next.book.ownerAddress?.toLowerCase() !== owner ||
                        next.book.isTestnet !== testnet ||
                        (selectedId && next.book.id !== selectedId)))
            ) {
                setView(null);
                throw new Error("Desk account context changed. Verify the wallet session.");
            }
            setView(next);
            setError("");
        } catch (e) {
            if (mounted.current && !controller.signal.aborted && seq === requestSeq.current)
                setError(e instanceof Error ? e.message : "Desk unavailable.");
        } finally {
            if (read.current === controller) read.current = null;
        }
    }, [owner, selectedId, testnet]);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            read.current?.abort();
            write.current?.abort();
        };
    }, []);
    useEffect(() => {
        void refresh();
        const timer = setInterval(() => {
            if (!working.current && !read.current) void refresh();
        }, 7000);
        return () => {
            read.current?.abort();
            clearInterval(timer);
        };
    }, [refresh]);
    function select(id: string) {
        ++requestSeq.current;
        read.current?.abort();
        setView(null);
        setSelectedId(id);
        setError("");
        setOperationError("");
        setNotice("");
        setAdding(false);
    }
    const act: Action = async (payload) => {
        if (working.current) return false;
        working.current = true;
        setBusy(true);
        setOperationError("");
        setNotice("");
        setError("");
        const controller = new AbortController();
        write.current = controller;
        try {
            const res = await fetch("/api/desk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            const reply = await res.json();
            if (!mounted.current || controller.signal.aborted) return false;
            if (!res.ok) {
                if (res.status === 409) await refresh();
                throw new Error(reply.error || "Desk rejected the operation.");
            }
            if (payload.action === "create" && selectedId !== reply.bookId) {
                select(reply.bookId);
                setPanel("Controls");
            } else await refresh();
            if (mounted.current)
                setNotice(payload.action === "message" ? "Message queued for the desk." : "Desk updated.");
            return true;
        } catch (e) {
            if (mounted.current && !controller.signal.aborted)
                setOperationError(e instanceof Error ? e.message : "Desk operation failed.");
            return false;
        } finally {
            working.current = false;
            if (mounted.current) setBusy(false);
        }
    };
    const book = view?.book;
    return (
        <div className="desk-stack">
            {book && !adding && (
                <nav ref={deskToolsNav} className="desk-tools" aria-label="Desk tools">
                    {deskToolNames.map((name) => {
                        const Icon = deskTools[name];
                        return (
                            <button type="button" key={name} aria-pressed={panel === name} aria-controls="desk-tool-panel"
                                onClick={() => setPanel(current => current === name ? "Desk simulation" : name)}>
                                <Icon size={14} aria-hidden="true" /> {name}
                            </button>
                        );
                    })}
                </nav>
            )}
            <div className="desk-session-bar">
                <div className="desk-session-context">
                    <h2>{book ? book.kind === "quoting" ? "Market-making book" : "Directional book" : "Your books"}</h2>
                    <small>{testnet ? "Testnet" : "Mainnet"} · {shortAddress(owner)}</small>
                </div>
                <div className="desk-session-actions">
                {!!view?.books.length && (
                    <label>
                        <span className="desk-visually-hidden">Active book</span>
                        <select disabled={busy} value={book?.id ?? ""} onChange={(e) => select(e.target.value)}>
                            {view.books.map((b) => (
                                <option key={b.id} value={b.id}>
                                    {b.kind} · {shortAddress(b.accountAddress)}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                {view && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                            setAdding(!adding);
                            setError("");
                        }}
                    >
                        {adding ? "Back to book" : "New book"}
                    </button>
                )}
                {book && !adding && (
                    <>
                        <span className={view?.killSwitch ? "desk-authority is-stopped" : "desk-authority"}>
                            {view?.killSwitch ? "Stop active" : book.enabled ? (view?.strategy?.state==="research_only" ? "Research active · new strategy stopped" : "Live orders enabled") : "Trading stopped"}
                        </span>
                        <button className="desk-danger desk-emergency" type="button"
                            disabled={busy || view?.killSwitch}
                            onClick={() => void act({ action: "kill", bookId: book.id, enabled: true })}>
                            {view?.killSwitch ? "Emergency stop active" : "Emergency stop"}
                        </button>
                    </>
                )}
                </div>
            </div>
            {(operationError || error) && (
                <p role="alert" className="desk-alert">
                    {operationError || error}
                </p>
            )}
            {notice && (
                <p role="status" className="desk-muted">
                    {notice}
                </p>
            )}
            {!view && !error && <p role="status">Loading trading books…</p>}
            {view && (adding || !book) && <CreateDeskBook owner={owner} testnet={testnet} busy={busy} act={act} />}
            {view && book && !adding && (
                <div key={book.id} className="desk-stack">
                    {view.strategy && <p className="desk-muted">{view.strategy.version} · {view.strategy.state === "active" ? "Strategy activated by operator" : "Whole-market research · strategy entries awaiting operator activation"}. Paper orders require a separately enabled testnet book.</p>}
                    {book.lastError && (
                        <details className="desk-saved-error">
                            <summary>Saved worker warning</summary>
                            <p>{book.lastError}</p>
                            <p className="desk-muted">Saved on the book. See Desk simulation for current analyst activity.</p>
                        </details>
                    )}
                    <section id="desk-tool-panel" aria-label={panel}>
                        {panel === "Desk simulation" ? (
                            <DeskOffice book={book} />
                        ) : panel === "Chat" ? (
                            <DeskChat book={book} chat={view.chat ?? []} busy={busy} act={act} error={operationError} onClose={closePanel} />
                        ) : panel === "Controls" ? (
                            <DeskControls key={book.id + ":" + book.version} book={book} killSwitch={view.killSwitch}
                                strategy={view.strategy} busy={busy} act={act} onClose={closePanel} />
                        ) : (
                            <div className="desk-panel">
                                <DeskPanelHeader title={panel} icon={deskTools[panel]} isTestnet={book.isTestnet} onClose={closePanel} />
                                {panel === "Market context" && <DeskMarketContext book={book} />}
                                {panel === "Journal" && <DeskJournal data={view} />}
                                {panel === "Book details" && <DeskBlotter data={view} act={act} busy={busy} showUsage={false} />}
                                {panel === "Usage" && <DeskUsage bookId={book.id} />}
                            </div>
                        )}
                    </section>
                </div>
            )}
        </div>
    );
}
export function TradingDesk() {
    const { walletSessionAddress, isTestnet } = useTrading();
    if (!walletSessionAddress)
        return (
            <section className="desk-card">
                <h2>Connect your trading wallet</h2>
                <p>Verify your wallet session to open your books.</p>
            </section>
        );
    return (
        <DeskSession
            key={walletSessionAddress.toLowerCase() + ":" + isTestnet}
            owner={walletSessionAddress.toLowerCase()}
            testnet={isTestnet}
        />
    );
}
