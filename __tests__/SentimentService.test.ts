import { describe, it, expect } from 'vitest'
import { SentimentService, SentimentPayload } from '../services/SentimentService'

describe('SentimentService.analyzePayload', () => {
    const service = new SentimentService()

    it('builds a snapshot with attention, tags, and change when messages are present', () => {
        const payload: SentimentPayload = {
            symbol: 'SOL',
            window_minutes: 120,
            baseline: {
                avg_mentions_24h: 100,
                expected_mentions_in_window: 3,
            },
            previous_snapshot: { score: 0.1 },
            messages: [
                {
                    id: 'news_1',
                    source: 'news',
                    text: 'Solana ETF approved, price target raised',
                    ts: Date.now() / 1000,
                },
                {
                    id: 'tw_1',
                    source: 'twitter',
                    text: 'SOL going to the moon, super bullish vibes',
                    ts: Date.now() / 1000,
                    likes: 20,
                    retweets: 5,
                },
                {
                    id: 'rd_1',
                    source: 'reddit',
                    text: 'Minor network outage noted but quickly fixed',
                    ts: Date.now() / 1000,
                    upvotes: 2,
                },
            ],
        }

        const snapshot = service.analyzePayload(payload)

        expect(snapshot.symbol).toBe('SOL')
        expect(snapshot.mentions).toBe(3)
        expect(snapshot.score).toBeGreaterThan(0.1)
        expect(snapshot.disagreement).toBeGreaterThan(0)
        expect(snapshot.mentions_vs_baseline).toBeCloseTo(1, 1)
        expect(snapshot.change_2h).toBeCloseTo(snapshot.score - 0.1, 5)
        expect(Object.keys(snapshot.source_mix).length).toBeGreaterThanOrEqual(2)
        expect(snapshot.tags).toEqual(expect.arrayContaining(['etf', 'network_outage']))
        expect(snapshot.notes.length).toBeGreaterThan(5)
    })

    it('returns a neutral fallback when no messages are available', () => {
        const payload: SentimentPayload = {
            symbol: 'BTC',
            window_minutes: 120,
            baseline: {
                avg_mentions_24h: 0,
                expected_mentions_in_window: 0,
            },
            previous_snapshot: { score: 0.2 },
            messages: [],
        }

        const snapshot = service.analyzePayload(payload)

        expect(snapshot.symbol).toBe('BTC')
        expect(snapshot.mentions).toBe(0)
        expect(snapshot.mentions_vs_baseline).toBe(1)
        expect(snapshot.score).toBe(0)
        expect(snapshot.disagreement).toBe(0.5)
        expect(snapshot.change_2h).toBeNull()
        expect(snapshot.source_mix).toEqual({})
        expect(snapshot.tags).toEqual([])
        expect(snapshot.notes).toContain('defaulting to neutral')
    })
})
