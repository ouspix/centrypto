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
    private subscriptions: any[] = [];
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelay = 1000;

    constructor(isTestnet: boolean = false) {
        super();
        this.isTestnet = isTestnet;
    }

    public connect() {
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
            this.subscriptions.push(sub);
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
        this.sendSubscription(subscription);
    }

    private sendSubscription(sub: any) {
        // Track subscription state if needed, or just send
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(sub));
        } else {
            // Queue it? For now, we assume connection is open or will be handled by reconnect
            // But for dynamic L2, we might not want to queue indefinitely if it's transient.
            // Let's just push to subscriptions list if it's a subscribe
            if (sub.method === 'subscribe') {
                this.subscriptions.push(sub);
            } else if (sub.method === 'unsubscribe') {
                this.subscriptions = this.subscriptions.filter(s =>
                    !(s.subscription.type === sub.subscription.type && s.subscription.coin === sub.subscription.coin)
                );
            }
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
        if (this.subscriptions.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
            console.log(`[HyperliquidWS] Resubscribing to ${this.subscriptions.length} channels...`);
            // Send in batches to avoid overwhelming the server
            const BATCH_SIZE = 50;
            for (let i = 0; i < this.subscriptions.length; i += BATCH_SIZE) {
                const batch = this.subscriptions.slice(i, i + BATCH_SIZE);
                setTimeout(() => {
                    batch.forEach(sub => this.ws?.send(JSON.stringify(sub)));
                }, i * 10); // Small stagger
            }
        }
    }

    private scheduleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts);
            console.log(`[HyperliquidWS] Reconnecting in ${delay}ms...`);
            setTimeout(() => {
                this.reconnectAttempts++;
                this.connect();
            }, delay);
        } else {
            console.error(`[HyperliquidWS] Max reconnect attempts reached.`);
            this.emit('error', new Error("Max reconnect attempts reached"));
        }
    }
}
