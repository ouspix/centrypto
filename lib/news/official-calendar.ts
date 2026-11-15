const eastern = "America/New_York";
const clock = new Intl.DateTimeFormat("en-CA", { timeZone: eastern, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export const officialCalendars = {
    bls: "https://www.bls.gov/schedule/news_release/bls.ics",
    fed: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
} as const;
export type CalendarSource = keyof typeof officialCalendars;
export type ScheduledEvent = {
    id: string; source: CalendarSource; title: string; date: string; startsAt: string | null;
    timezone: string; url: string; publishedAt: null; cancelled: boolean;
};

function dateString(y: number, m: number, d: number) {
    const value = new Date(Date.UTC(y, m - 1, d));
    if (value.getUTCFullYear() !== y || value.getUTCMonth() !== m - 1 || value.getUTCDate() !== d) throw new Error("Invalid calendar date");
    return value.toISOString().slice(0, 10);
}
function easternParts(at: number) {
    return Object.fromEntries(clock.formatToParts(at).map(part => [part.type, Number(part.value)]));
}
export function easternTime(date: string, hour: number, minute: number, second = 0) {
    if (hour > 23 || minute > 59 || second > 59) throw new Error("Invalid calendar time");
    const [y, m, d] = date.split("-").map(Number);
    const desired = Date.UTC(y, m - 1, d, hour, minute, second);
    for (const offset of [4, 5]) {
        const at = desired + offset * 3600_000;
        const local = easternParts(at);
        if (local.year === y && local.month === m && local.day === d && local.hour === hour &&
            local.minute === minute && local.second === second) return new Date(at).toISOString();
    }
    throw new Error("Calendar time does not exist in Eastern time");
}

export function parseBlsCalendar(input: string) {
    if (!/^BEGIN:VCALENDAR\b/m.test(input) || !/^END:VCALENDAR\b/m.test(input)) throw new Error("BLS calendar format changed");
    const text = input.replace(/\r?\n[ \t]/g, "").replace(/\r/g, "");
    const events: ScheduledEvent[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(/^BEGIN:VEVENT\n([\s\S]*?)^END:VEVENT$/gm)) {
        const fields = new Map(match[1].trim().split("\n").map(line => {
            const colon = line.indexOf(":");
            return [line.slice(0, colon), line.slice(colon + 1)] as const;
        }));
        const title = (fields.get("SUMMARY") ?? "").replace(/\\([,;\\])/g, "$1");
        if (!/consumer price index|producer price index|employment situation|job openings and labor turnover/i.test(title)) continue;
        const uid = fields.get("UID");
        const start = [...fields].find(([key]) => /^DTSTART(?:;|$)/.test(key));
        const parts = start?.[1].match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?$/);
        if (!uid || !start || !parts || seen.has(uid)) throw new Error("Invalid BLS event");
        seen.add(uid);
        const date = dateString(+parts[1], +parts[2], +parts[3]);
        let startsAt: string | null = null;
        if (parts[4]) {
            if (+parts[4] > 23 || +parts[5] > 59 || +parts[6] > 59) throw new Error("Invalid BLS clock");
            if (parts[7]) startsAt = new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3], +parts[4], +parts[5], +parts[6])).toISOString();
            else if (!start[0].includes("TZID=") || /TZID="?(?:America\/New_York|US-Eastern)"?/i.test(start[0]))
                startsAt = easternTime(date, +parts[4], +parts[5], +parts[6]);
            else throw new Error("Unsupported BLS timezone");
        }
        events.push({ id: "bls:" + uid, source: "bls", title, date, startsAt, timezone: parts[7] ? "UTC" : eastern,
            url: officialCalendars.bls, publishedAt: null, cancelled: fields.get("STATUS") === "CANCELLED" });
    }
    if (!events.length) throw new Error("No supported BLS events parsed");
    return events;
}

const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&(?:ndash|mdash);|[–—]/g, "-").replace(/\s+/g, " ").trim();

export function parseFedMeetings(html: string, minYear: number) {
    const headings = [...html.matchAll(/<h4[^>]*>\s*<a[^>]*>(\d{4}) FOMC Meetings<\/a>\s*<\/h4>/gi)];
    if (!headings.length) throw new Error("Fed meeting calendar format changed");
    const events: ScheduledEvent[] = [];
    for (const [i, heading] of headings.entries()) {
        const year = +heading[1];
        if (year < minYear) continue;
        const body = html.slice(heading.index, headings[i + 1]?.index);
        let ordinal = 0;
        for (const row of body.matchAll(/class="[^"]*\bfomc-meeting__month\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div class="[^"]*\bfomc-meeting__date\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g)) {
            if (/notation vote|unscheduled/i.test(strip(row[2]))) continue;
            const month = months.indexOf(strip(row[1]).toLowerCase().split(/\s*[-/]\s*/).at(-1)!);
            const day = strip(row[2]).match(/^\d{1,2}(?:\s*-\s*(\d{1,2}))?\*?$/);
            if (month === -1 || !day) throw new Error("Unrecognized Fed meeting date");
            const date = dateString(year, month + 1, day[1] ? +day[1] : parseInt(day[0], 10));
            events.push({ id: "fed:meeting:" + year + ":" + ++ordinal, source: "fed", title: "FOMC decision",
                date, startsAt: null, timezone: eastern, url: officialCalendars.fed, publishedAt: null, cancelled: false });
        }
    }
    if (!events.length) throw new Error("No Fed meeting dates parsed");
    return events;
}

export function parseFedMonth(html: string, year: number, month: number, url: string) {
    if (!new RegExp("<h4[^>]*>\\s*" + months[month - 1] + "\\s+" + year + "\\s*</h4>", "i").test(html))
        throw new Error("Fed month format changed");
    const events: ScheduledEvent[] = [];
    const starts = html.search(/<h[1-6][^>]*>\s*FOMC Meetings\s*<\/h[1-6]>/i);
    if (starts < 0) return events;
    const section = html.slice(starts).replace(/^[\s\S]*?<\/h[1-6]>/i, "").split(/<h[1-5]\b/i)[0];
    for (const row of section.matchAll(/<div class="col-xs-2"[^>]*>([\s\S]*?)<\/div>\s*<div class="col-xs-7"[^>]*>([\s\S]*?)<\/div>\s*<div class="col-xs-3"[^>]*>([\s\S]*?)<\/div>/gi)) {
        const label = strip(row[2]), datePart = strip(row[3]);
        const kind = /^FOMC Minutes\b/i.test(label) ? "minutes" : /^FOMC Press Conference\b/i.test(label) ? "press" :
            /^FOMC Meeting\b/i.test(label) ? "meeting" : null;
        if (!kind) continue;
        if (!/^\d{1,2}$/.test(datePart)) throw new Error("Invalid Fed release day");
        const date = dateString(year, month, +datePart);
        const time = strip(row[1]).match(/^(\d{1,2}):(\d\d)\s*([ap])\.?m\.?$/i);
        const startsAt = time ? easternTime(date, +time[1] % 12 + (time[3].toLowerCase() === "p" ? 12 : 0), +time[2]) : null;
        events.push({ id: "fed:" + kind + ":" + date.slice(0, 7), source: "fed",
            title: kind === "minutes" ? "FOMC minutes" : kind === "press" ? "FOMC press conference" : "FOMC decision",
            date, startsAt, timezone: eastern, url, publishedAt: null, cancelled: false });
    }
    return events;
}
export const fedMonthUrl = (year: number, month: number) => "https://www.federalreserve.gov/newsevents/" + year + "-" + months[month - 1] + ".htm";
