import Vader from 'vader-sentiment';
import { prisma } from '../lib/db';
import { getSymbolConfig } from '../sentiment/config';

export type SentimentMessage = {
    id: string;
    source: "reddit" | "twitter" | "news" | "telegram" | "other";
    text: string;
    ts: number;
    upvotes?: number;
    replies?: number;
    retweets?: number;
    likes?: number;
};

export type SentimentPayload = {
    symbol: string;
    window_minutes: number;
    baseline: {
        avg_mentions_24h?: number;
        expected_mentions_in_window?: number;
    };
    previous_snapshot?: {
        score: number | null;
    };
    messages: SentimentMessage[];
};

export type SentimentSnapshot = {
    symbol: string;
    score: number;
    disagreement: number;
    mentions: number;
    mentions_vs_baseline: number;
    change_2h: number | null;
    source_mix: Record<string, number>;
    tags: string[];
    sentiment_confidence?: number;
    notes: string;
};

const DEFAULT_AVG_MENTIONS_24H = 48;
const DEFAULT_WINDOW_MINUTES = 120;

export class SentimentService {
    /**
     * Public entry-point used across the app. It reads the latest snapshot from
     * the DB without triggering any fresh downloads. Ingestion is handled by the
     * standalone sentiment script.
     */
    public async getSentimentForCoin(coin: string, previousScore: number | null = null): Promise<SentimentSnapshot> {
        const symbol = coin.toUpperCase();
        try {
            const snapshot = await this.fetchLatestSnapshot(symbol);
            if (snapshot) {
                return this.mapRowToSnapshot(snapshot);
            }
        } catch (error) {
            console.error('Sentiment Service Error:', error);
        }
        return {
            symbol,
            score: 0,
            disagreement: 0.5,
            mentions: 0,
            mentions_vs_baseline: 1.0,
            change_2h: previousScore !== null ? 0 - previousScore : null,
            source_mix: {},
            tags: [],
            notes: 'Failed to compute sentiment; defaulting to neutral.'
        };
    }

    private async fetchLatestSnapshot(symbol: string) {
        const known = Object.keys(getSymbolConfig());
        if (!known.includes(symbol)) {
            console.warn(`Unknown symbol for sentiment lookup: ${symbol}`);
            return null;
        }
        return prisma.symbolSentimentSnapshot.findFirst({
            where: { symbol },
            orderBy: { updatedAt: 'desc' }
        });
    }

    private mapRowToSnapshot(row: any): SentimentSnapshot {
        let source_mix: Record<string, number> = {};
        let tags: string[] = [];
        try {
            source_mix = row.sourceMixJson ? JSON.parse(row.sourceMixJson) : {};
        } catch {
            source_mix = {};
        }
        try {
            tags = row.tagsJson ? JSON.parse(row.tagsJson) : [];
        } catch {
            tags = [];
        }

        return {
            symbol: row.symbol,
            score: row.score,
            disagreement: row.disagreement,
            mentions: row.mentions,
            mentions_vs_baseline: row.mentionsVsBaseline,
            change_2h: row.change2h,
            source_mix,
            tags,
            sentiment_confidence: this.buildConfidence(row.mentions),
            notes: this.buildNotes(row.score, row.mentionsVsBaseline, row.disagreement, row.change2h, tags)
        };
    }

    private buildNotes(score: number, mentions_vs_baseline: number, disagreement: number, change_2h: number, tags: string[]) {
        const attentionText = mentions_vs_baseline > 2
            ? 'attention spike'
            : mentions_vs_baseline > 1.2
                ? 'attention elevated'
                : 'attention normal';
        const mood = score > 0.3 ? 'bullish' : score < -0.3 ? 'bearish' : 'neutral';
        const disagreementText = disagreement > 0.5 ? 'polarized' : 'consensus';
        const changeText = `change2h ${change_2h >= 0 ? '+' : ''}${change_2h.toFixed(2)}`;
        return `${mood} mood, ${attentionText}, ${disagreementText}; ${changeText}. Tags: ${tags.length ? tags.join(', ') : 'none'}.`;
    }

    private buildConfidence(mentions: number) {
        return mentions < 10 ? Math.max(0.2, mentions / 10) : 1;
    }

    /**
     * Core SentimentAgent logic that transforms a batch of messages into a compact snapshot.
     */
    public analyzePayload(payload: SentimentPayload): SentimentSnapshot {
        const relevantMessages = payload.messages.filter(m => m.text && m.text.trim().length > 0);
        const mentions = relevantMessages.length;
        const expected = payload.baseline?.expected_mentions_in_window && payload.baseline.expected_mentions_in_window > 0
            ? payload.baseline.expected_mentions_in_window
            : 1;
        if (mentions === 0) {
            return {
                symbol: payload.symbol,
                score: 0,
                disagreement: 0.5,
                mentions: 0,
                mentions_vs_baseline: 1.0,
                change_2h: null,
                source_mix: {},
                tags: [],
                notes: 'No relevant messages in window; defaulting to neutral.'
            };
        }
        const mentions_vs_baseline = expected > 0 ? mentions / expected : 1.0;

        let weightedSum = 0;
        let totalWeight = 0;
        const scores: number[] = [];

        relevantMessages.forEach(msg => {
            const intensity = Vader.SentimentIntensityAnalyzer.polarity_scores(msg.text);
            const engagement = (msg.upvotes || 0) + (msg.likes || 0) + (msg.retweets || 0) + (msg.replies || 0);
            const attentionWeight = 1 + Math.log1p(engagement);
            const sourceBias = msg.source === "news" ? 1.1 : 1;
            const weight = attentionWeight * sourceBias;

            weightedSum += intensity.compound * weight;
            totalWeight += weight;
            scores.push(intensity.compound);
        });

        const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

        const variance = scores.length > 0
            ? scores.reduce((sum, s) => sum + Math.pow(s - score, 2), 0) / scores.length
            : 0;
        const disagreement = Math.min(1, Math.sqrt(variance));

        const change_2h = payload.previous_snapshot && payload.previous_snapshot.score !== null && payload.previous_snapshot.score !== undefined
            ? score - payload.previous_snapshot.score
            : null;

        const source_mix = this.buildSourceMix(relevantMessages, mentions);
        const tags = this.extractTags(relevantMessages.map(m => m.text));

        const attentionText = mentions_vs_baseline > 2
            ? 'attention spike'
            : mentions_vs_baseline > 1.2
                ? 'attention elevated'
                : 'attention normal';

        const mood = score > 0.3 ? 'bullish' : score < -0.3 ? 'bearish' : 'neutral';
        const disagreementText = disagreement > 0.5 ? 'polarized' : 'consensus';
        const changeText = change_2h !== null ? `change2h ${change_2h >= 0 ? '+' : ''}${change_2h.toFixed(2)}` : 'change2h n/a';

        const notes = `${mood} mood, ${attentionText}, ${disagreementText}; ${changeText}. Tags: ${tags.length ? tags.join(', ') : 'none'}.`;

        return {
            symbol: payload.symbol,
            score,
            disagreement,
            mentions,
            mentions_vs_baseline,
            change_2h,
            source_mix,
            tags,
            notes
        };
    }

    private buildSourceMix(messages: SentimentMessage[], mentions: number): Record<string, number> {
        if (mentions === 0) return {};
        const counts: Record<string, number> = {};
        messages.forEach(msg => {
            counts[msg.source] = (counts[msg.source] || 0) + 1;
        });
        const mix: Record<string, number> = {};
        Object.entries(counts).forEach(([source, count]) => {
            mix[source] = parseFloat((count / mentions).toFixed(3));
        });
        return mix;
    }

    private extractTags(texts: string[]): string[] {
        const tags = new Set<string>();
        texts.forEach(text => {
            const lower = text.toLowerCase();
            if (lower.includes('etf')) tags.add('etf');
            if (lower.includes('list')) tags.add('listing');
            if (lower.includes('airdrop')) tags.add('airdrop');
            if (lower.includes('hack') || lower.includes('exploit') || lower.includes('breach')) tags.add('hack');
            if (lower.includes('lawsuit') || lower.includes('sue')) tags.add('lawsuit');
            if (lower.includes('regulation') || lower.includes('sec') || lower.includes('cftc')) tags.add('regulation');
            if (lower.includes('upgrade') || lower.includes('fork')) tags.add('upgrade');
            if (lower.includes('outage') || lower.includes('offline') || lower.includes('downtime')) tags.add('network_outage');
            if (lower.includes('partnership') || lower.includes('partner')) tags.add('partnership');
            if (lower.includes('meme')) tags.add('meme');
            if (lower.includes('pump')) tags.add('pump');
            if (lower.includes('dump') || lower.includes('rug')) tags.add('dump');
        });
        return Array.from(tags);
    }
}
