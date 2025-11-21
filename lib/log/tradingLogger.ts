import fs from 'fs';
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

    constructor() {
        this.logDir = path.join(process.cwd(), 'logs', 'trading');
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    public async logDecision(entry: LogEntry) {
        const date = new Date().toISOString().split('T')[0];
        const logFile = path.join(this.logDir, `trade_log_${date}.jsonl`);

        const logLine = JSON.stringify({
            ts: new Date().toISOString(),
            ...entry
        });

        try {
            fs.appendFileSync(logFile, logLine + '\n');
        } catch (error) {
            console.error("Failed to write to trade log:", error);
        }
    }
}
