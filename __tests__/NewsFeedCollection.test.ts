import fs from "fs";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("extension feed collection", () => {
    it("fetches leased feeds without credentials or tabs and shares one offscreen parser", async () => {
        const tasks = ["1", "2"].map(id => ({ id, source: { id, adapter: "rss", url: `https://example.com/rss/${id}` } }));
        const chrome = {
            storage: { local: { get: vi.fn(async key => key === "bridgeToken" ? { bridgeToken: "paired" } : {}), set: vi.fn(async () => {}), remove: vi.fn() }, session: { get: vi.fn(async () => ({})) } },
            permissions: { contains: vi.fn(async () => true) },
            tabs: { create: vi.fn() },
            offscreen: { createDocument: vi.fn(async () => new Promise(resolve => setTimeout(resolve, 10))) },
            runtime: { getURL: vi.fn(file => `chrome-extension://collector/${file}`), getContexts: vi.fn(async () => []), sendMessage: vi.fn(async (_message: unknown) => ({ status: "healthy", captures: [] })), onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() } },
            alarms: { get: vi.fn(async () => ({})), onAlarm: { addListener: vi.fn() } }
        };
        let served = false;
        const fetch = vi.fn(async (url, options) => {
            if (String(url).startsWith("https://example.com/")) {
                expect(options).toMatchObject({ credentials: "omit", redirect: "error" });
                let read = false;
                return { ok: true, status: 200, body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: Buffer.from("<rss><channel/></rss>") }), cancel: vi.fn(async () => {}) }) } };
            }
            return { ok: true, json: async () => {
                if (!String(url).endsWith("/v1/tasks")) return { acknowledged: true };
                const next = served ? [] : tasks; served = true;
                return { tasks: next };
            } };
        });
        new Function("chrome", "fetch", fs.readFileSync("collector/extension/background.js", "utf8"))(chrome, fetch);
        await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2));
        expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
        expect(chrome.offscreen.createDocument).toHaveBeenCalledWith(expect.objectContaining({ reasons: ["DOM_PARSER"] }));
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(chrome.runtime.sendMessage.mock.calls[0][0]).toMatchObject({ target: "rss-parser", source: { feedXml: "<rss><channel/></rss>" } });
        await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/v1/captures"))).toHaveLength(2));
        for (const [, options] of fetch.mock.calls.filter(([url]) => String(url).endsWith("/v1/captures"))) expect(options.body).not.toContain("feedXml");
    });
    it("refuses feed-parser messages from other extensions or web tabs", () => {
        const addListener = vi.fn();
        new Function("chrome", fs.readFileSync("collector/extension/rss-parser.js", "utf8"))({ runtime: { id: "collector", onMessage: { addListener } } });
        const handler = addListener.mock.calls[0][0];
        const message = { target: "rss-parser", source: { adapter: "rss", feedXml: "<rss/>" } };
        const respond = vi.fn();
        expect(handler(message, { id: "foreign" }, respond)).toBe(false);
        expect(handler(message, { id: "collector", tab: { id: 1 } }, respond)).toBe(false);
        expect(respond).not.toHaveBeenCalled();
    });
});
