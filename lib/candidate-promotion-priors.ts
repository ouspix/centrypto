import { promises as fs } from "fs";
import path from "path";
import {
    normalizeCandidatePromotionConfig,
    type CandidatePromotionConfig,
    type CandidatePromotionPriorStatus
} from "@/lib/candidate-promotion";

export type CandidatePromotionPriorBucket = {
    playbook: string;
    side: string;
    regime: string;
    inPlayBucket: string;
    setupBucket: string;
    costBucket: string;
    key: string;
    horizonMinutes: number;
    episodes: number;
    avgNetBps: number;
    status: CandidatePromotionPriorStatus;
    positive: boolean;
};

export type CandidatePromotionPriorSource = {
    source: string;
    updatedAt: string | null;
    sizeBytes: number | null;
};

const ROLLING_PRIOR_PATH = path.join(process.cwd(), "data", "calibration", "latest", "rolling_prior.csv");
const ROLLING_PRIOR_SOURCE = "data/calibration/latest/rolling_prior.csv";

export async function getCandidatePromotionPriorSource(): Promise<CandidatePromotionPriorSource> {
    try {
        const stats = await fs.stat(ROLLING_PRIOR_PATH);
        return {
            source: ROLLING_PRIOR_SOURCE,
            updatedAt: stats.mtime.toISOString(),
            sizeBytes: stats.size
        };
    } catch {
        return {
            source: ROLLING_PRIOR_SOURCE,
            updatedAt: null,
            sizeBytes: null
        };
    }
}

export async function readCandidatePromotionPriorBuckets(config?: unknown): Promise<CandidatePromotionPriorBucket[]> {
    const promotionConfig = normalizeCandidatePromotionConfig(config);
    const text = await fs.readFile(ROLLING_PRIOR_PATH, "utf8");
    const rows = parseCsv(text);
    return rows
        .map(row => priorBucketFromCsvRow(row, promotionConfig))
        .filter((row): row is CandidatePromotionPriorBucket => !!row)
        .sort((left, right) =>
            Number(right.positive) - Number(left.positive) ||
            right.episodes - left.episodes ||
            right.avgNetBps - left.avgNetBps ||
            left.key.localeCompare(right.key)
        );
}

export async function validateLivePriorBuckets(config?: unknown): Promise<void> {
    const promotionConfig = normalizeCandidatePromotionConfig(config);
    const liveKeys = Object.entries(promotionConfig.prior_buckets)
        .filter(([, value]) => value.status === "LIVE")
        .map(([key]) => key);
    if (liveKeys.length === 0) return;

    const buckets = await readCandidatePromotionPriorBuckets(promotionConfig);
    const positiveKeys = new Set(buckets.filter(bucket => bucket.positive).map(bucket => bucket.key));
    const invalid = liveKeys.filter(key => !positiveKeys.has(key));
    if (invalid.length > 0) {
        throw new Error(`LIVE prior buckets must be positive in rolling_prior.csv: ${invalid.slice(0, 5).join(", ")}`);
    }
}

function priorBucketFromCsvRow(
    row: Record<string, string>,
    config: CandidatePromotionConfig
): CandidatePromotionPriorBucket | null {
    const key = row.key || [
        row.playbook,
        row.side,
        row.regime,
        row.in_play_score_bucket,
        row.setup_score_bucket,
        row.cost_bucket
    ].join("|");
    if (!key || key.includes("undefined")) return null;
    const episodes = finiteNumber(row.episode_count);
    const avgNetBps = finiteNumber(row.avg_60m_net_bps);
    const status = config.prior_buckets[key]?.status ?? "OFF";

    return {
        playbook: row.playbook || "NO_PLAYBOOK",
        side: row.side || "unknown",
        regime: row.regime || "UNKNOWN",
        inPlayBucket: row.in_play_score_bucket || "00-39",
        setupBucket: row.setup_score_bucket || "00-39",
        costBucket: row.cost_bucket || "25+",
        key,
        horizonMinutes: Math.trunc(finiteNumber(row.horizon_minutes)),
        episodes,
        avgNetBps,
        status,
        positive: episodes > 0 && avgNetBps > 0
    };
}

function parseCsv(text: string): Array<Record<string, string>> {
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map(line => {
        const values = parseCsvLine(line);
        return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    });
}

function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = "";
    let quoted = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === "\"") {
            if (quoted && line[i + 1] === "\"") {
                current += "\"";
                i++;
            } else {
                quoted = !quoted;
            }
            continue;
        }
        if (char === "," && !quoted) {
            values.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    values.push(current);
    return values;
}

function finiteNumber(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
