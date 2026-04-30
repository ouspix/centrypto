import { beforeEach, describe, expect, it, vi } from "vitest";

const wsInstances: any[] = [];

vi.mock("ws", () => {
    class MockWebSocket {
        static OPEN = 1;
        static CONNECTING = 0;
        readyState = MockWebSocket.OPEN;
        sent: string[] = [];
        handlers: Record<string, Function> = {};

        constructor(public url: string) {
            wsInstances.push(this);
            setTimeout(() => this.handlers.open?.(), 0);
        }

        on(event: string, handler: Function) {
            this.handlers[event] = handler;
        }

        send(message: string) {
            this.sent.push(message);
        }

        close() {
            this.handlers.close?.();
        }

        removeAllListeners() {
            this.handlers = {};
        }
    }

    return { default: MockWebSocket };
});

describe("HyperliquidWS subscription lifecycle", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        wsInstances.length = 0;
        vi.resetModules();
    });

    it("does not resubscribe an unsubscribed symbol after reconnect", async () => {
        const { HyperliquidWS } = await import("@/lib/hyperliquid-ws");
        const ws = new HyperliquidWS(true);
        ws.connect();
        vi.runOnlyPendingTimers();

        ws.subscribeToL2Book("BTC");
        ws.subscribeToL2Book("ETH");
        ws.unsubscribeFromL2Book("BTC");

        wsInstances[0].readyState = 3;
        wsInstances[0].handlers.close();
        vi.advanceTimersByTime(1000);
        vi.runOnlyPendingTimers();
        vi.runOnlyPendingTimers();

        const latest = wsInstances[1];
        const sent = latest.sent.map((msg: string) => JSON.parse(msg));
        expect(sent.some((msg: any) => msg.subscription?.coin === "ETH" && msg.method === "subscribe")).toBe(true);
        expect(sent.some((msg: any) => msg.subscription?.coin === "BTC" && msg.method === "subscribe")).toBe(false);
    });

    it("destroy stops reconnect and ping loops", async () => {
        const { HyperliquidWS } = await import("@/lib/hyperliquid-ws");
        const ws = new HyperliquidWS(true);
        ws.connect();
        vi.runOnlyPendingTimers();
        ws.destroy();
        vi.runOnlyPendingTimers();

        expect(wsInstances).toHaveLength(1);
    });
});
