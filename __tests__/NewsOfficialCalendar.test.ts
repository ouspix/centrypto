import { describe, expect, it } from "vitest";
import { parseBlsCalendar, parseFedMeetings, parseFedMonth } from "@/lib/news/official-calendar";

describe("official news calendars", () => {
    it("parses Eastern summer and winter releases and preserves date-only precision", () => {
        const input = [
            "BEGIN:VCALENDAR",
            "BEGIN:VEVENT", "UID:cpi", "SUMMARY:Consumer Price Index", "DTSTART;TZID=US-Eastern:20260710T083000", "END:VEVENT",
            "BEGIN:VEVENT", "UID:ppi", "SUMMARY:Producer Price Index", "DTSTART;TZID=US-Eastern:20261210T083000", "STATUS:CANCELLED", "END:VEVENT",
            "BEGIN:VEVENT", "UID:jobs", "SUMMARY:Employment Situation", "DTSTART;VALUE=DATE:20261211", "END:VEVENT",
            "END:VCALENDAR",
        ].join("\r\n");
        expect(parseBlsCalendar(input)).toMatchObject([
            { startsAt: "2026-07-10T12:30:00.000Z", publishedAt: null },
            { startsAt: "2026-12-10T13:30:00.000Z", cancelled: true },
            { startsAt: null, date: "2026-12-11" },
        ]);
        expect(() => parseBlsCalendar(input.replace("US-Eastern", "Mars/Olympus"))).toThrow();
    });
    it("keeps annual FOMC meetings date-only until the official monthly release includes a clock", () => {
        const annual = '<h4><a id="year">2026 FOMC Meetings</a></h4><div class="fomc-meeting--shaded fomc-meeting__month col-xs-5"><strong>December</strong></div><div class="fomc-meeting__date col-xs-4">8-9*</div>';
        expect(parseFedMeetings(annual, 2026)).toMatchObject([{ title: "FOMC decision", date: "2026-12-09", startsAt: null }]);
        const month = '<h4>December 2026</h4><h4>FOMC Meetings</h4><div class="col-xs-2"><p>2:00 p.m.</p></div><div class="col-xs-7"><p>FOMC Meeting</p></div><div class="col-xs-3"><p>9</p></div><h4>Statistical Releases</h4>';
        expect(parseFedMonth(month, 2026, 12, "https://www.federalreserve.gov/newsevents/2026-december.htm"))
            .toMatchObject([{ title: "FOMC decision", startsAt: "2026-12-09T19:00:00.000Z" }]);
        expect(() => parseFedMonth(month, 2026, 11, "https://www.federalreserve.gov/newsevents/2026-november.htm")).toThrow();
    });
});
