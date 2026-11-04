import { describe, expect, it } from "vitest";
import { observeNews } from "@/lib/news/observation";
const registry = [{ id: "a", url: "https://x.com/example", enabled: true, priority: 1 }];
const start = new Date("2026-10-30T09:00:00Z");
function observedDay(healthy = true) {
    let observation = observeNews(null, registry, healthy, true, start);
    for (let minute = 1; minute <= 1440; minute++) observation = observeNews(observation, registry, healthy, true, new Date(start.getTime() + minute * 60_000));
    return observation;
}
describe("news observation gate", () => {
    it("requires a full healthy day and analyzed evidence", () => {
        expect(observeNews(null, registry, true, true, start).ready).toBe(false);
        const ready = observedDay();
        expect(ready.ready).toBe(true);
        expect(observeNews(ready, registry, true, false, new Date(start.getTime() + 1441 * 60_000)).ready).toBe(false);
    });
    it("counts downtime as unhealthy coverage", () => {
        const first = observeNews(null, registry, true, true, start);
        const afterDowntime = observeNews(first, registry, true, true, new Date(start.getTime() + 86_400_000));
        expect(afterDowntime.samples).toBe(1441);
        expect(afterDowntime.healthySamples).toBe(2);
        expect(afterDowntime.ready).toBe(false);
        expect(observedDay(false).ready).toBe(false);
    });
    it("restarts observation when configured sources change", () => {
        const next = observeNews(observedDay(), [...registry, { ...registry[0], id: "b" }], true, true, new Date(start.getTime() + 86_460_000));
        expect(next.ready).toBe(false);
        expect(next.samples).toBe(1);
    });
    it("closes the gate immediately on a new collection failure", () => {
        expect(observeNews(observedDay(), registry, false, true, new Date(start.getTime() + 86_460_000)).ready).toBe(false);
    });
});
