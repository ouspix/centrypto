import fs from "fs";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
function run(previousBrowser: object, currentBrowser: object) {
    const chrome = {
        storage: { local: { get: vi.fn(async () => previousBrowser), remove: vi.fn(async () => {}) }, session: { get: vi.fn(async () => currentBrowser), remove: vi.fn(async () => {}) } },
        tabs: { remove: vi.fn(async () => {}) },
        alarms: { get: vi.fn(async () => ({})), create: vi.fn(), onAlarm: { addListener: vi.fn() } },
        runtime: { onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() } }
    };
    new Function("chrome", "fetch", fs.readFileSync("collector/extension/background.js", "utf8"))(chrome, vi.fn());
    return chrome;
}
describe("collector browser restart", () => {
    it("serializes authenticated Telegram foreground loads and restores the human tab", async () => {
        let active = 9;
        let nextId = 100;
        const order: string[] = [];
        const tasks = ["1", "2"].map(id => ({ id, source: { id, adapter: "telegram", url: `https://web.telegram.org/a/#-100${id}` } }));
        const chrome = {
            storage: { local: { get: vi.fn(async key => key === "bridgeToken" ? { bridgeToken: "paired" } : {}), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }, session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
            permissions: { contains: vi.fn(async () => true) },
            tabs: {
                query: vi.fn(async () => [{ id: active }]),
                create: vi.fn(async () => ({ id: nextId++ })),
                update: vi.fn(async (id, options) => { if (options.active) { active = id; order.push(`active:${id}`); } }),
                get: vi.fn(async () => ({ status: "complete" })),
                remove: vi.fn(async id => { order.push(`remove:${id}`); })
            },
            scripting: { executeScript: vi.fn(async input => {
                if (input.files) return [];
                expect(active).toBe(input.target.tabId);
                order.push(`extract:${input.target.tabId}`);
                return [{ result: { status: "healthy", captures: [] } }];
            }) },
            alarms: { get: vi.fn(async () => ({})), create: vi.fn(), onAlarm: { addListener: vi.fn() } },
            runtime: { onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() } }
        };
        let served = false;
        const fetch = vi.fn(async url => ({ ok: true, json: async () => {
            if (!String(url).endsWith("/v1/tasks")) return { acknowledged: true };
            const next = served ? [] : tasks;
            served = true;
            return { tasks: next };
        } }));
        new Function("chrome", "fetch", fs.readFileSync("collector/extension/background.js", "utf8"))(chrome, fetch);
        await waitFor(() => expect(chrome.tabs.remove).toHaveBeenCalledTimes(2));
        expect(order).toEqual(["active:100", "extract:100", "active:9", "remove:100", "active:101", "extract:101", "active:9", "remove:101"]);
        expect(active).toBe(9);
        expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/v1/tasks"))).toHaveLength(2);
    });
    it("never closes a human tab using a stale tab ID from an earlier browser session", async () => {
        const chrome = run({ "collectorTab:7": "old-task" }, {});
        await waitFor(() => expect(chrome.storage.local.remove).toHaveBeenCalledWith("collectorTab:7"));
        expect(chrome.tabs.remove).not.toHaveBeenCalled();
    });
    it("cleans up owned collection tabs after a service-worker restart in the same browser", async () => {
        const chrome = run({}, { "collectorTab:8": "interrupted-task" });
        await waitFor(() => expect(chrome.storage.session.remove).toHaveBeenCalledWith("collectorTab:8"));
        expect(chrome.tabs.remove).toHaveBeenCalledTimes(1);
        expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
    });
});
