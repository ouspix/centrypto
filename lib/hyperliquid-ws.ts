import WebSocket from 'ws';
import { EventEmitter } from 'events';

type WsCandle = {
    t: number; // open time
    T: number; // close time
    s: string; // symbol
    i: string; // interval
    o: string; // open
    c: string; // close
    h: string; // high
    l: string; // low
    v: string; // volume
    n: number; // number of trades
}

export class HyperliquidWS extends EventEmitter {
    private ws: WebSocket | null = null;
    private isTestnet: boolean;
    private pingInterval: NodeJS.Timeout | null = null;
    private subscriptions = new Map<string, any>();
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelay = 1000;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private destroyed = false;

    constructor(isTestnet: boolean = false) {
        super();
        this.isTestnet = isTestnet;
    }

    public connect() {
        if (this.destroyed) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        const url = this.isTestnet
            ? "wss://api.hyperliquid-testnet.xyz/ws"
            : "wss://api.hyperliquid.xyz/ws";

        console.log(`[HyperliquidWS] Connecting to ${url}...`);
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            console.log(`[HyperliquidWS] Connected.`);
            this.reconnectAttempts = 0;
            this.startPing();
            this.resubscribe();
            this.emit('open');
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleMessage(message);
            } catch (error) {
                console.error(`[HyperliquidWS] Error parsing message:`, error);
            }
        });

        this.ws.on('close', () => {
            console.log(`[HyperliquidWS] Disconnected.`);
            this.stopPing();
            this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
            console.error(`[HyperliquidWS] Error:`, error);
        });
    }

    public subscribeToCandles(coins: string[]) {
        const subscription = {
            method: "subscribe",
            subscription: {
                type: "candle",
                coin: "", // Will be replaced in loop
                interval: "1m"
            }
        };

        // Store for resubscription
        // We store individual subscriptions because the API requires one per coin
        coins.forEach(coin => {
            const sub = { ...subscription, subscription: { ...subscription.subscription, coin } };
            this.subscriptions.set(subscriptionKey(sub.subscription), sub);
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(sub));
            }
        });

        console.log(`[HyperliquidWS] Queued subscriptions for ${coins.length} symbols.`);
    }

    public subscribeToL2Book(coin: string) {
        const subscription = {
            method: "subscribe",
            subscription: {
                type: "l2Book",
                coin: coin
            }
        };
        this.subscriptions.set(subscriptionKey(subscription.subscription), subscription);
        this.sendSubscription(subscription);
    }

    public unsubscribeFromL2Book(coin: string) {
        const subscription = {
            method: "unsubscribe",
            subscription: {
                type: "l2Book",
                coin: coin
            }
        };
        this.subscriptions.delete(subscriptionKey(subscription.subscription));
        this.sendSubscription(subscription);
    }

    public close() {
        this.destroy();
    }

    public destroy() {
        this.destroyed = true;
        this.stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            try {
                this.ws.close();
            } catch {
                // Ignore close errors during teardown.
            }
            this.ws = null;
        }
    }

    private sendSubscription(sub: any) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(sub));
        }
    }

    private handleMessage(message: any) {
        if (message.channel === 'candle') {
            const candle = message.data as WsCandle;
            this.emit('candle', candle);
        } else if (message.channel === 'l2Book') {
            // message.data = { coin: "ETH", levels: [[...], [...]], time: 1234567890 }
            this.emit('l2Book', message.data);
        }
    }

    private startPing() {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ method: "ping" }));
            }
        }, 30000);
    }

    private stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    private resubscribe() {
        const active = Array.from(this.subscriptions.values());
        if (active.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
            console.log(`[HyperliquidWS] Resubscribing to ${active.length} channels...`);
            // Send in batches to avoid overwhelming the server
            const BATCH_SIZE = 50;
            for (let i = 0; i < active.length; i += BATCH_SIZE) {
                const batch = active.slice(i, i + BATCH_SIZE);
                setTimeout(() => {
                    if (this.destroyed) return;
                    batch.forEach(sub => this.ws?.send(JSON.stringify(sub)));
                }, i * 10); // Small stagger
            }
        }
    }

    private scheduleReconnect() {
        if (this.destroyed) return;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts);
            console.log(`[HyperliquidWS] Reconnecting in ${delay}ms...`);
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.destroyed) return;
                this.reconnectAttempts++;
                this.connect();
            }, delay);
        } else {
            console.error(`[HyperliquidWS] Max reconnect attempts reached.`);
            this.emit('error', new Error("Max reconnect attempts reached"));
        }
    }
}

const sharedWs = new Map<string, HyperliquidWS>();

export function getSharedHyperliquidWS(isTestnet: boolean = false): HyperliquidWS {
    const key = isTestnet ? "testnet" : "mainnet";
    const existing = sharedWs.get(key);
    if (existing) return existing;
    const ws = new HyperliquidWS(isTestnet);
    sharedWs.set(key, ws);
    return ws;
}

function subscriptionKey(subscription: { type: string; coin?: string; interval?: string }): string {
    return `${subscription.type}:${subscription.coin ?? ""}:${subscription.interval ?? ""}`;
}
