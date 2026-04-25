import { promises as fs } from 'fs';
import path from 'path';

export type LogEntry = {
    timestamp: string;
    snapshot: any; // Can be large, maybe hash it or store summary
    decision: any;
    riskAssessment: any;
    executionResult?: any;
};

export class TradingLogger {
    private logDir: string;
    private dirReady: Promise<void>;

    constructor() {
        this.logDir = path.join(process.cwd(), 'logs', 'trading');
        this.dirReady = fs.mkdir(this.logDir, { recursive: true }).then(() => undefined);
    }

    public async logDecision(entry: LogEntry) {
        await this.dirReady;
        const date = new Date().toISOString().split('T')[0];
        const logFile = path.join(this.logDir, `trade_log_${date}.jsonl`);

        const logLine = JSON.stringify({
            ts: new Date().toISOString(),
            ...entry
        });

        try {
            await fs.appendFile(logFile, logLine + '\n');
        } catch (error) {
            console.error("Failed to write to trade log:", error);
        }
    }
}
