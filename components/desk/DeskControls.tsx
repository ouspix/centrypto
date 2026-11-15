"use client";
import { useEffect, useState } from "react";
import { Save, SlidersHorizontal } from "lucide-react";
import { SWING_DESK_MANDATE, parseDeskMandate, type DeskMandate } from "@/lib/desk/mandate";
import { mandateLabels, shortAddress, type Book, type Action } from "./desk-view";
import { DeskPanelHeader } from "./DeskPanelHeader";

function MandateInputs({ value, onChange }: { value: DeskMandate; onChange: (next: DeskMandate) => void }) {
    return (
        <>
            {(Object.keys(mandateLabels) as (keyof DeskMandate)[]).map((key) => (
                <label className="desk-panel-field" key={key}>
                    {mandateLabels[key]}
                    <input
                        type="number"
                        step="any"
                        min="0.00001"
                        required={value[key]!==undefined}
                        value={Number.isFinite(value[key]) ? value[key] : ""}
                        onChange={(e) => onChange({ ...value, [key]: e.target.valueAsNumber })}
                    />
                </label>
            ))}
        </>
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
        [mandate, setMandate] = useState<DeskMandate>(SWING_DESK_MANDATE),
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
            <div className="desk-formgrid">
                <MandateInputs value={mandate} onChange={setMandate} />
            </div>
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
            className="desk-control-form desk-control-handover"
            onSubmit={async (e) => {
                e.preventDefault();
                if (chosen && (await act({ action: "handover", bookId: book.id, instrumentId: chosen }))) setMatch("");
            }}
        >
            <div>
                <h3>Hand over an existing position</h3>
                <p>Transfer management of the selected instrument’s current position to this book.</p>
            </div>
            <div className="desk-control-fields">
                <label className="desk-panel-field">
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
                <label className="desk-panel-field">
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
            </div>
            {error && <p role="alert" className="desk-panel-error">{error}</p>}
            <div className="desk-control-actions">
                <button className="desk-panel-secondary" disabled={busy || !chosen} type="submit">
                    Hand over selected position
                </button>
            </div>
        </form>
    );
}

export function DeskControls({
    book,
    killSwitch,
    strategy,
    busy,
    act,
    onClose,
}: {
    book: Book;
    killSwitch: boolean;
    strategy?: {version:string;state:string}|null;
    busy: boolean;
    act: Action;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState<DeskMandate>(() => parseDeskMandate(book.mandateJson)),
        [frequency, setFrequency] = useState(book.frequencySeconds),
        [error, setError] = useState("");
    const liveSettings = { action: "configure", bookId: book.id, version: book.version };
    const strategyActive = strategy?.state === "active";
    return (
        <div className="desk-panel desk-controls">
            <DeskPanelHeader title="Controls" icon={SlidersHorizontal} isTestnet={book.isTestnet} onClose={onClose} />
            <div className="desk-controls-layout">
                <form
                    className="desk-control-form desk-control-mandate"
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
                    <h3>Book mandate</h3>
                    <div className="desk-control-fields">
                        <MandateInputs value={draft} onChange={setDraft} />
                        <label className="desk-panel-field">
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
                    </div>
                    {error && <p role="alert" className="desk-panel-error">{error}</p>}
                    <div className="desk-control-actions">
                        <button className="desk-panel-primary" disabled={busy} type="submit">
                            Save mandate <Save size={15} aria-hidden="true" />
                        </button>
                    </div>
                </form>
                <section className="desk-control-authority">
                    <h3>Trading authority</h3>
                    <div>
                        <h4>{book.kind === "quoting" ? "Quoting subaccount" : "Directional book"}</h4>
                        <p>
                            {shortAddress(book.accountAddress)} ·{" "}
                            <strong className="desk-control-status" data-active={book.enabled}>
                                {book.enabled ? (book.isTestnet ? "Paper active" : "Live active") : "Stopped"}
                            </strong>
                        </p>
                        {book.isTestnet && <p>Paper trading places actual orders on Hyperliquid testnet with test funds. Mainnet balances and permissions remain separate.</p>}
                        <button
                            type="button"
                            className={book.enabled ? "desk-panel-secondary desk-danger" : "desk-panel-secondary"}
                            disabled={busy || (!book.enabled && killSwitch)}
                            onClick={() => void act({ ...liveSettings, enabled: !book.enabled })}
                        >
                            {book.enabled ? "Stop book" : book.isTestnet ? "Activate paper trading (testnet)" : "Enable live mainnet trading"}
                        </button>
                    </div>
                    {!!draft.maxOpenRiskUsd && (
                        <div>
                            <h4>{strategy?.version === "desk-discretionary-1" ? "Discretionary desk" : "Continuation strategy"}</h4>
                            <p>
                                <strong className="desk-control-status" data-active={strategyActive}>
                                    {strategyActive ? "Entries activated" : "Research only"}
                                </strong>
                            </p>
                            {!strategyActive && <p>Review its evidence before activation.</p>}
                            <button
                                type="button"
                                className="desk-panel-secondary"
                                disabled={busy}
                                onClick={() => void act({
                                    action: "strategy_state", bookId: book.id, version: book.version,
                                    strategyVersion: strategy?.version ?? "continuation-1",
                                    state: strategyActive ? "research_only" : "active",
                                })}
                            >
                                {strategyActive ? "Return strategy to research only" : "Activate strategy entries"}
                            </button>
                        </div>
                    )}
                    <div>
                        <h4>Wallet kill switch</h4>
                        <p>
                            <strong className="desk-control-status" data-alert={killSwitch}>{killSwitch ? "Active" : "Clear"}</strong>
                            {" · Affects all books on this network."}
                        </p>
                        <button
                            className="desk-panel-secondary desk-danger"
                            type="button"
                            disabled={busy}
                            onClick={() => void act({ action: "kill", bookId: book.id, enabled: !killSwitch })}
                        >
                            {killSwitch ? "Clear wallet kill switch" : "Activate wallet kill switch"}
                        </button>
                    </div>
                </section>
                <Handover book={book} busy={busy} act={act} />
            </div>
        </div>
    );
}
