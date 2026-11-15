import { createHash } from "node:crypto";
import { newsDb } from "@/lib/news-db";
import { fedMonthUrl, officialCalendars, parseBlsCalendar, parseFedMeetings, parseFedMonth, type CalendarSource, type ScheduledEvent } from "./official-calendar";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function sourceText(url: string, signal: AbortSignal) {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Centrypto calendar reader)", Accept: "text/calendar,text/html" } });
    if (!response.ok || !response.body) throw new Error("Official calendar unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "", bytes = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2_000_000) throw new Error("Official calendar too large");
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
}
function easternDate(at: number) {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York" }).format(at);
}
async function fetchEvents(source: CalendarSource, now: number, signal: AbortSignal) {
    if (source === "bls") return { events: parseBlsCalendar(await sourceText(officialCalendars.bls, signal)), complete: true };
    const [year, month] = easternDate(now).split("-").map(Number);
    const annual = parseFedMeetings(await sourceText(officialCalendars.fed, signal), year);
    const [throughYear, throughMonth] = easternDate(now + 30 * DAY).split("-").map(Number);
    const months = Array.from({ length: (throughYear - year) * 12 + throughMonth - month + 1 },
        (_, offset) => new Date(Date.UTC(year, month - 1 + offset, 1)));
    const upcoming = await Promise.allSettled(months.map(async d => {
        const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, url = fedMonthUrl(y, m);
        return parseFedMonth(await sourceText(url, signal), y, m, url);
    }));
    const monthly = upcoming.flatMap(result => result.status === "fulfilled" ? result.value : []);
    const events = annual.map(event => {
        const details = monthly.find(m => m.title === event.title && m.date === event.date);
        return details ? { ...details, id: event.id } : event;
    });
    return { events: [...events, ...monthly.filter(m => !events.some(e => e.title === m.title && e.date === m.date))],
        complete: upcoming.every(result => result.status === "fulfilled") };
}

export async function refreshOfficialCalendars(ownerAddress: string, signal: AbortSignal) {
    const now = Date.now(), today = easternDate(now);
    await Promise.all((Object.keys(officialCalendars) as CalendarSource[]).map(async source => {
        const where = { ownerAddress, source };
        const previous = await newsDb.newsCalendarRevision.findFirst({ where, orderBy: { observedAt: "desc" } });
        if (previous && now - +previous.checkedAt < HOUR) return;
        let status = "healthy";
        let events: ScheduledEvent[];
        try {
            const result = await fetchEvents(source, now, signal);
            events = result.events;
            if (!result.complete) status = "incomplete";
        } catch {
            status = "unavailable";
            events = [];
        }
        signal.throwIfAborted();
        const old = (previous ? JSON.parse(previous.dataJson) : []) as ScheduledEvent[];
        if (status === "unavailable") events = old;
        else {
            for (const event of old) {
                if (event.date < today || events.some(e => e.id === event.id)) continue;
                // A complete source revision can remove an event. A failed or partial read cannot.
                events.push({ ...event, cancelled: status === "healthy" || event.cancelled });
            }
        }
        events = events.filter(event => event.date >= easternDate(now - 7 * DAY))
            .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
        const dataJson = JSON.stringify(events), hash = createHash("sha256").update(dataJson).digest("hex");
        const checkedAt = new Date();
        await newsDb.newsCalendarRevision.create({ data: { ...where, hash, status, dataJson, checkedAt, observedAt: checkedAt } });
        await newsDb.newsCalendarRevision.deleteMany({ where: { ...where, observedAt: { lt: new Date(now - 180 * DAY) } } });
    }));
}

export async function readOfficialCalendars(ownerAddress: string, at: number, days: number) {
    const today = easternDate(at), through = easternDate(at + days * DAY);
    const sources = await Promise.all((Object.keys(officialCalendars) as CalendarSource[]).map(async source => {
        const row = await newsDb.newsCalendarRevision.findFirst({
            where: { ownerAddress, source, observedAt: { lte: new Date(at) } }, orderBy: { observedAt: "desc" },
        });
        const status = !row ? "unavailable" : at - +row.checkedAt > 3 * HOUR ? "stale" : row.status;
        const events = row && status !== "unavailable" && status !== "stale"
            ? (JSON.parse(row.dataJson) as ScheduledEvent[]).filter(event => !event.cancelled && event.date >= today &&
                event.date <= through && (event.startsAt == null || Date.parse(event.startsAt) >= at))
                .map(event => ({ ...event, observedAt: row.observedAt.toISOString(), revisionId: row.id })) : [];
        return { source, status, url: officialCalendars[source], checkedAt: row && +row.checkedAt <= at ? row.checkedAt.toISOString() : null, events };
    }));
    return sources;
}
