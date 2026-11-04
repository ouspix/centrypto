"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTrading } from "@/context/TradingContext";
import { DeskBlotter, DeskJournal } from "./DeskBlotter";
import { CreateDeskBook, DeskControls } from "./DeskControls";
import {
    dateTime,
    field,
    readData,
    shortAddress,
    type Action,
    type Book,
    type JournalEntry,
    type Overview,
} from "./desk-view";

function DeskChat({ book, records, busy, act }: { book: Book; records: JournalEntry[]; busy: boolean; act: Action }) {
    const [kind, setKind] = useState<"research" | "instruction">("research"),
        [message, setMessage] = useState("");
    const retry = useRef<{ key: string; id: string } | null>(null);
    const history = records
        .filter((r) => r.kind === "message" || (r.kind === "note" && r.role === "lead"))
        .slice(0, 8)
        .reverse();
    const selected = book.enabled ? kind : "research";
    return (
        <aside className="desk-card desk-stack desk-chat">
            <h2>Desk chat</h2>
            <div className="desk-messages">
                {history.length === 0 && (
                    <p className="desk-muted">Ask the lead about an opportunity, a pass, or a position.</p>
                )}
                {history.map((r) => {
                    const d = readData(r.dataJson);
                    return (
                        <article key={r.id} className="desk-entry">
                            <header>
                                <strong>{r.role === "lead" ? "Head trader" : "Operator"}</strong>
                                <time>{dateTime(r.createdAt)}</time>
                            </header>
                            <p>{field(d, "message") || field(d, "summary")}</p>
                        </article>
                    );
                })}
            </div>
            <form
                className="desk-stack"
                onSubmit={async (e) => {
                    e.preventDefault();
                    const text = message.trim();
                    if (!text || busy) return;
                    const key = JSON.stringify([book.id, selected, text]);
                    if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() };
                    if (
                        await act({
                            action: "message",
                            bookId: book.id,
                            kind: selected,
                            message: text,
                            requestId: retry.current.id,
                        })
                    ) {
                        setMessage("");
                        retry.current = null;
                    }
                }}
            >
                <label>
                    Message type
                    <select value={selected} onChange={(e) => setKind(e.target.value as typeof kind)}>
                        <option value="research">Research request</option>
                        <option value="instruction" disabled={!book.enabled}>
                            Trading instruction
                        </option>
                    </select>
                </label>
                <label>
                    Message to the desk
                    <textarea
                        required
                        maxLength={4000}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder={
                            selected === "research"
                                ? "What changed in the SOL thesis?"
                                : "Which order should the live lead work?"
                        }
                    />
                </label>
                <button type="submit" disabled={busy || !message.trim()}>
                    {selected === "research" ? "Send research request" : "Send live instruction"}
                </button>
            </form>
        </aside>
    );
}

function DeskSession({ owner, testnet }: { owner: string; testnet: boolean }) {
    const [selectedId, setSelectedId] = useState("");
    const [view, setView] = useState<Overview | null>(null),
        [panel, setPanel] = useState<"Blotter" | "Journal" | "Controls">("Blotter");
    const [adding, setAdding] = useState(false),
        [error, setError] = useState(""),
        [notice, setNotice] = useState(""),
        [busy, setBusy] = useState(false);
    const [updated, setUpdated] = useState("");
    const mounted = useRef(true),
        requestSeq = useRef(0),
        working = useRef(false);
    const read = useRef<AbortController | null>(null),
        write = useRef<AbortController | null>(null);
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
            setUpdated(new Date().toISOString());
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
        setNotice("");
        setAdding(false);
    }
    const act: Action = async (payload) => {
        if (working.current) return false;
        working.current = true;
        setBusy(true);
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
                setError(e instanceof Error ? e.message : "Desk operation failed.");
            return false;
        } finally {
            working.current = false;
            if (mounted.current) setBusy(false);
        }
    };
    const book = view?.book;
    return (
        <div className="desk-stack">
            <div className="desk-toolbar">
                <div>
                    <small>{testnet ? "TESTNET" : "MAINNET"} · VERIFIED WALLET</small>
                    <p>{shortAddress(owner)}</p>
                </div>
                {!!view?.books.length && (
                    <label>
                        Active book
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
            </div>
            {error && (
                <p role="alert" className="desk-alert">
                    {error}
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
                    <div className="desk-toolbar">
                        <div>
                            <h2>{book.kind === "quoting" ? "Market-making book" : "Directional book"}</h2>
                            <p className="desk-muted">
                                Worker heartbeat {dateTime(book.heartbeatAt)} · View updated {dateTime(updated)}
                            </p>
                        </div>
                        <strong className={view.killSwitch ? "desk-flag danger" : "desk-flag"}>
                            {view.killSwitch
                                ? "Wallet kill switch active"
                                : book.enabled
                                  ? "Enabled for live orders"
                                  : "Stopped"}
                        </strong>
                    </div>
                    {book.lastError && (
                        <p role="alert" className="desk-alert">
                            {book.lastError}
                        </p>
                    )}
                    <nav className="desk-tabs" aria-label="Desk views">
                        {(["Blotter", "Journal", "Controls"] as const).map((p) => (
                            <button type="button" key={p} aria-pressed={panel === p} onClick={() => setPanel(p)}>
                                {p}
                            </button>
                        ))}
                    </nav>
                    <div className="desk-columns">
                        <div>
                            {panel === "Blotter" ? (
                                <DeskBlotter data={view} act={act} busy={busy} />
                            ) : panel === "Journal" ? (
                                <DeskJournal data={view} />
                            ) : (
                                <DeskControls
                                    key={book.id + ":" + book.version}
                                    book={book}
                                    killSwitch={view.killSwitch}
                                    busy={busy}
                                    act={act}
                                />
                            )}
                        </div>
                        <DeskChat book={book} records={view.records} busy={busy} act={act} />
                    </div>
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
