"use client";
import { useEffect, useState } from "react";
import { DEFAULT_DESK_MANDATE, parseDeskMandate, type DeskMandate } from "@/lib/desk/mandate";
import { mandateLabels, shortAddress, type Book, type Action } from "./desk-view";

function MandateInputs({ value, onChange }: { value: DeskMandate; onChange: (next: DeskMandate) => void }) {
    return (
        <div className="desk-formgrid">
            {(Object.keys(mandateLabels) as (keyof DeskMandate)[]).map((key) => (
                <label key={key}>
                    {mandateLabels[key]}
                    <input
                        type="number"
                        step="any"
                        min="0.00001"
                        required
                        value={Number.isFinite(value[key]) ? value[key] : ""}
                        onChange={(e) => onChange({ ...value, [key]: e.target.valueAsNumber })}
                    />
                </label>
            ))}
        </div>
    );
}

export function CreateDeskBook({
    owner,
    testnet,
    act,
    busy,
}: {
    owner: string;
    testnet: boolean;
    act: Action;
    busy: boolean;
}) {
    const [kind, setKind] = useState("directional"),
        [account, setAccount] = useState(owner),
        [mandate, setMandate] = useState(DEFAULT_DESK_MANDATE),
        [error, setError] = useState("");
    return (
        <form
            className="desk-card desk-stack"
            onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                try {
                    await act({
                        action: "create",
                        isTestnet: testnet,
                        kind,
                        accountAddress: account.trim(),
                        mandate: parseDeskMandate(mandate),
                    });
                } catch (err) {
                    setError(err instanceof Error ? err.message : "Invalid mandate");
                }
            }}
        >
            <h2>Create a stopped book</h2>
            <label>
                Book type
                <select
                    value={kind}
                    onChange={(e) => {
                        setKind(e.target.value);
                        setAccount(e.target.value === "quoting" ? "" : owner);
                    }}
                >
                    <option value="directional">Directional and relative value</option>
                    <option value="quoting">Dedicated market-making subaccount</option>
                </select>
            </label>
            <label>
                {kind === "quoting" ? "Dedicated subaccount address" : "Account or subaccount address"}
                <input
                    required
                    pattern="0x[a-fA-F0-9]{40}"
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    spellCheck={false}
                />
            </label>
            <MandateInputs value={mandate} onChange={setMandate} />
            {error && <p role="alert">{error}</p>}
            <button disabled={busy} type="submit">
                Create stopped book
            </button>
        </form>
    );
}

type Choice = { id: string; base: string; quote: string; coin: string; kind: string };
function Handover({ book, act, busy }: { book: Book; act: Action; busy: boolean }) {
    const [match, setMatch] = useState(""),
        [items, setItems] = useState<Choice[]>([]),
        [chosen, setChosen] = useState(""),
        [error, setError] = useState("");
    useEffect(() => {
        setItems([]);
        setChosen("");
        setError("");
        if (!match.trim()) return;
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const query = new URLSearchParams({
                    bookId: book.id,
                    network: book.isTestnet ? "testnet" : "mainnet",
                    instruments: match.trim(),
                });
                const res = await fetch("/api/desk?" + query, { signal: controller.signal, cache: "no-store" });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || "Instrument search failed");
                if (!controller.signal.aborted) setItems(data.instruments);
            } catch (e) {
                if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Instrument search failed");
            }
        }, 250);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [book.id, book.isTestnet, match]);
    return (
        <form
            className="desk-card desk-stack"
            onSubmit={async (e) => {
                e.preventDefault();
                if (chosen && (await act({ action: "handover", bookId: book.id, instrumentId: chosen }))) setMatch("");
            }}
        >
            <h2>Hand over an existing position</h2>
            <p>Transfer management of the selected instrument’s current position to this book.</p>
            <label>
                Find instrument
                <input
                    value={match}
                    maxLength={80}
                    onChange={(e) => {
                        setChosen("");
                        setItems([]);
                        setMatch(e.target.value);
                    }}
                    placeholder="Ticker or public name"
                />
            </label>
            <label>
                Position to hand over
                <select required value={chosen} onChange={(e) => setChosen(e.target.value)}>
                    <option value="">Select the exact spot pair or perpetual</option>
                    {items.map((i) => (
                        <option key={i.id} value={i.id}>
                            {i.base}/{i.quote} · {i.kind} · {i.id}
                        </option>
                    ))}
                </select>
            </label>
            {error && <p role="alert">{error}</p>}
            <button disabled={busy || !chosen} type="submit">
                Hand over selected position
            </button>
        </form>
    );
}

export function DeskControls({
    book,
    killSwitch,
    busy,
    act,
}: {
    book: Book;
    killSwitch: boolean;
    busy: boolean;
    act: Action;
}) {
    const [draft, setDraft] = useState<DeskMandate>(() => parseDeskMandate(book.mandateJson)),
        [frequency, setFrequency] = useState(book.frequencySeconds),
        [error, setError] = useState("");
    const liveSettings = { action: "configure", bookId: book.id, version: book.version };
    return (
        <div className="desk-stack">
            <section className="desk-card desk-stack">
                <h2>Trading authority</h2>
                <p>
                    {book.kind === "quoting" ? "Quoting subaccount" : "Directional book"}{" "}
                    {shortAddress(book.accountAddress)} on {book.isTestnet ? "testnet" : "mainnet"} ·{" "}
                    {book.enabled ? "Enabled" : "Stopped"}
                </p>
                <button
                    type="button"
                    className={book.enabled ? "desk-danger" : ""}
                    disabled={busy || (!book.enabled && killSwitch)}
                    onClick={() => void act({ ...liveSettings, enabled: !book.enabled })}
                >
                    {book.enabled ? "Stop book" : `Enable live ${book.isTestnet ? "testnet" : "mainnet"} trading`}
                </button>
                <p>
                    Wallet kill switch affects all books on this network. Current state:{" "}
                    <strong>{killSwitch ? "active" : "clear"}</strong>.
                </p>
                <button
                    className="desk-danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void act({ action: "kill", bookId: book.id, enabled: !killSwitch })}
                >
                    {killSwitch ? "Clear wallet kill switch" : "Activate wallet kill switch"}
                </button>
            </section>
            <form
                className="desk-card desk-stack"
                onSubmit={async (e) => {
                    e.preventDefault();
                    setError("");
                    try {
                        await act({ ...liveSettings, mandate: parseDeskMandate(draft), frequencySeconds: frequency });
                    } catch (err) {
                        setError(err instanceof Error ? err.message : "Invalid mandate");
                    }
                }}
            >
                <h2>Book mandate</h2>
                <MandateInputs value={draft} onChange={setDraft} />
                <label>
                    Review interval (seconds)
                    <input
                        type="number"
                        required
                        min={60}
                        max={86400}
                        value={Number.isFinite(frequency) ? frequency : ""}
                        onChange={(e) => setFrequency(e.target.valueAsNumber)}
                    />
                </label>
                {error && <p role="alert">{error}</p>}
                <button disabled={busy} type="submit">
                    Save mandate
                </button>
            </form>
            <Handover book={book} busy={busy} act={act} />
        </div>
    );
}
