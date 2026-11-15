"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, CheckCheck, Clock3, MessageSquare, Search, ShieldCheck } from "lucide-react";
import { dateTime, field, readData, type Action, type Book, type ChatThread } from "./desk-view";
import { chatRequestId } from "./chat-request-id";
import { DeskPanelHeader } from "./DeskPanelHeader";

const starters = ["What is the strongest opportunity right now?", "Why did we pass on the last trade?", "What would change your current view?"];
const statusLabels: Record<string, string> = {
    answered: "Answered", queued: "Queued for the desk", running: "Reviewing your message",
    paused: "Review paused", failed: "Review failed", expired: "Request expired",
    superseded: "Book settings changed — send again", completed: "Review finished without a reply",
};

export function DeskChat({ book, chat, busy, act, error, onClose }: {
    book: Book; chat: ChatThread[]; busy: boolean; act: Action; error?: string; onClose?: () => void;
}) {
    const [kind, setKind] = useState<"research" | "instruction">("research");
    const [message, setMessage] = useState("");
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState("");
    const [sent, setSent] = useState(false);
    const retry = useRef<{ key: string; id: string } | null>(null);
    const submitting = useRef(false);
    const scroller = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const followLatest = useRef(true);
    const id = useId();
    const selected = book.enabled ? kind : "research";
    const pending = chat.filter(thread => !thread.reply && ["queued", "running", "paused"].includes(thread.status)).length;
    const latest = chat.at(-1);
    const activity = `${chat.length}:${latest?.message.id}:${latest?.reply?.id}:${latest?.status}`;

    useEffect(() => {
        if (followLatest.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    }, [activity]);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const text = message.trim();
        if (!text || busy || submitting.current) return;
        submitting.current = true;
        setSending(true);
        setSendError("");
        setSent(false);
        try {
            const key = JSON.stringify([book.id, selected, text]);
            if (retry.current?.key !== key) retry.current = { key, id: chatRequestId() };
            const accepted = await act({ action: "message", bookId: book.id, kind: selected, message: text, requestId: retry.current.id });
            if (accepted) {
                setMessage("");
                retry.current = null;
                setSent(true);
                followLatest.current = true;
                if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
            } else {
                setSendError("Message not sent. Your draft is saved here; try again.");
            }
        } catch (cause) {
            setSendError(cause instanceof Error ? cause.message : "Message not sent. Please try again.");
        } finally {
            submitting.current = false;
            setSending(false);
        }
    }

    function applyStarter(text: string) {
        setMessage(text);
        setSent(false);
        input.current?.focus();
    }

    return (
        <section className="desk-panel" aria-label="Desk chat">
            <DeskPanelHeader title="Head trader" icon={MessageSquare} isTestnet={book.isTestnet}
                eyebrow="DIRECT LINE TO YOUR DESK" description="Research, decisions, and the reasoning behind them."
                onClose={onClose} closeLabel="Close chat" />
            <div className="chat-layout">
                <aside className="chat-sidebar" aria-label="Conversation navigation">
                    <span className="desk-panel-eyebrow">CONVERSATION</span>
                    <div className="chat-channel"><MessageSquare size={16} /><div><strong>Desk chat</strong><small>{chat.length} {chat.length === 1 ? "request" : "requests"} · {pending} awaiting reply</small></div></div>
                    <div className="chat-recent">
                        <span className="desk-panel-eyebrow">RECENT QUESTIONS</span>
                        {chat.length ? [...chat].reverse().slice(0, 6).map(thread => <button key={thread.message.id} type="button" onClick={() => {
                            followLatest.current = false;
                            const target = document.getElementById(`${id}-${thread.message.id}`);
                            target?.scrollIntoView({ block: "nearest" });
                            target?.focus({ preventScroll: true });
                        }}><span>{field(readData(thread.message.dataJson), "message")}</span><small>{dateTime(thread.message.createdAt)}</small></button>) : <p>Your questions will appear here.</p>}
                    </div>
                    <div className="chat-context"><ShieldCheck size={17} /><div><strong>{book.enabled ? "Book enabled" : "Trading stopped"}</strong><p>Research requests are read-only. {book.enabled ? "Trading instructions use your book’s existing limits." : "You can still ask questions and review ideas."}</p></div></div>
                </aside>
                <div className="chat-main">
                    <div className="chat-transcript" ref={scroller} role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions text" onScroll={() => {
                        const el = scroller.current;
                        if (el) followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                    }}>
                        {chat.length === 0 ? <div className="chat-empty">
                            <span className="chat-empty-mark"><MessageSquare size={28} /></span>
                            <span className="desk-panel-eyebrow">LET’S LOOK AT THE EVIDENCE</span>
                            <h3>A better decision starts<br />with a good question.</h3>
                            <p>Ask about a setup, challenge a pass, or get the story behind a position.</p>
                            <div className="chat-starters">{starters.map(text => <button key={text} type="button" disabled={sending} onClick={() => applyStarter(text)}>{text}<ArrowUp size={14} /></button>)}</div>
                        </div> : chat.map(({ message: request, reply, status }) => {
                            const question = readData(request.dataJson);
                            const answer = reply ? readData(reply.dataJson) : {};
                            return <div className="chat-exchange" key={request.id} id={`${id}-${request.id}`} tabIndex={-1}>
                                <article className="chat-message chat-message-user" aria-label="Your message">
                                    <header><span>You <i>· {field(question, "mode") === "live" ? "Trading instruction" : "Research"}</i></span><time dateTime={request.createdAt}>{dateTime(request.createdAt)}</time></header>
                                    <div className="chat-bubble"><p>{field(question, "message")}</p></div>
                                    <small className="chat-delivery" data-state={status}>{status === "answered" ? <CheckCheck size={13} /> : <Clock3 size={13} />}{statusLabels[status] ?? `Request ${status}`}</small>
                                </article>
                                {reply && <article className="chat-message chat-message-lead" aria-label="Head trader reply">
                                    <header><span className="chat-lead-icon" aria-hidden="true"><MessageSquare size={13} /></span><strong>Head trader</strong><time dateTime={reply.createdAt}>{dateTime(reply.createdAt)}</time></header>
                                    <div className="chat-bubble"><p className="chat-answer-summary">{field(answer, "summary")}</p>
                                        {field(answer, "thesis") && <p>{field(answer, "thesis")}</p>}
                                        {field(answer, "invalidation") && <div className="chat-answer-detail"><span>WHAT WOULD CHANGE THIS</span><p>{field(answer, "invalidation")}</p></div>}
                                        {field(answer, "dissent") && <div className="chat-answer-detail chat-counterpoint"><span>COUNTERPOINT</span><p>{field(answer, "dissent")}</p></div>}
                                    </div>
                                </article>}
                            </div>;
                        })}
                    </div>
                    <form className="chat-composer" onSubmit={submit} aria-busy={sending}>
                        <div className="chat-composer-top"><label className="chat-mode"><Search size={14} aria-hidden="true" /><span className="desk-visually-hidden">Message type</span>
                            <select value={selected} disabled={sending} onChange={event => setKind(event.target.value as typeof kind)}>
                                <option value="research">Research request</option><option value="instruction" disabled={!book.enabled}>Trading instruction</option>
                            </select></label>
                            {!!chat.length && <button type="button" className="chat-latest" onClick={() => { followLatest.current = true; if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }}><ArrowDown size={12} /> Latest</button>}
                        </div>
                        <label htmlFor={`${id}-draft`} className="desk-visually-hidden">Message to the desk</label>
                        <textarea id={`${id}-draft`} ref={input} value={message} required maxLength={4000} disabled={sending} rows={3}
                            placeholder={selected === "research" ? "Ask your desk a question…" : "Give the lead a trading instruction…"}
                            onChange={event => { setMessage(event.target.value); setSent(false); }}
                            aria-describedby={`${id}-hint`}
                            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
                        {sendError && <p role="alert" className="chat-send-error">{error || sendError}</p>}
                        {sent && <p role="status" className="chat-send-success"><CheckCheck size={14} /> Sent to the desk. The reply will appear here.</p>}
                        <footer><span id={`${id}-hint`}>Enter to send <b>·</b> Shift + Enter for a new line</span><small>{message.length.toLocaleString()} / 4,000</small>
                            <button className="desk-panel-primary" type="submit" disabled={busy || sending || !message.trim()} aria-label={selected === "research" ? "Send research request" : book.isTestnet ? "Send paper instruction" : "Send live instruction"}>{sending ? "Sending…" : "Send"}<ArrowUp size={16} aria-hidden="true" /></button>
                        </footer>
                    </form>
                </div>
            </div>
        </section>
    );
}
