// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { turnDeadline } from "@/lib/desk/turn-deadline";
afterEach(() => { vi.useRealTimers(); });
describe("desk turn deadlines", () => {
    it("preserves the remaining model budget across overlapping specialist waits", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const fail = vi.fn();
        const deadline = turnDeadline(210000, 600000, fail);
        vi.advanceTimersByTime(100000);
        const a = deadline.pause();
        vi.advanceTimersByTime(50000);
        const b = deadline.pause();
        vi.advanceTimersByTime(150000);
        a(); a();
        vi.advanceTimersByTime(50000);
        expect(fail).not.toHaveBeenCalled();
        b();
        vi.advanceTimersByTime(109999);
        expect(fail).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fail.mock.calls).toEqual([["model"]]);
        vi.advanceTimersByTime(600000);
        expect(fail).toHaveBeenCalledTimes(1);
    });
    it("bounds a stalled tool by wall time and cancels timers on completion", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const fail = vi.fn();
        const deadline = turnDeadline(210000, 600000, fail);
        const resume = deadline.pause();
        vi.advanceTimersByTime(600000);
        expect(fail.mock.calls).toEqual([["wall"]]);
        resume();
        const completed = turnDeadline(210000, 600000, fail);
        completed.dispose();
        vi.advanceTimersByTime(600000);
        expect(fail).toHaveBeenCalledTimes(1);
    });
});
