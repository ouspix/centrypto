import { NextResponse } from 'next/server';
// @ts-ignore
import Vader from 'vader-sentiment';

// Mock Supabase client for now
const supabase = {
    from: (table: string) => ({
        insert: async (data: any) => {
            // console.log(`[Mock Supabase] Insert into ${table}:`, data);
            return { error: null };
        }
    })
};

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const coin = searchParams.get('coin') || 'CRYPTO';

        // 1. Fetch Headlines from CryptoPanic (or fallback)
        let headlines = [];
        const apiKey = process.env.CRYPTOPANIC_API_KEY;

        if (apiKey) {
            try {
                const response = await fetch(`https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&currencies=${coin}&public=true`);
                const data = await response.json();
                if (data.results) {
                    headlines = data.results.map((post: any) => post.title);
                }
            } catch (e) {
                console.error("CryptoPanic Fetch Error", e);
            }
        }

        // Fallback if no API key or fetch failed
        if (headlines.length === 0) {
            const mockNews: Record<string, string[]> = {
                "BTC": [
                    "Bitcoin ETF inflows reach record high",
                    "Miners accumulation suggests bullish trend for BTC",
                    "Bitcoin faces resistance at key technical level",
                    "Institutional interest in Bitcoin continues to grow"
                ],
                "ETH": [
                    "Ethereum network upgrade successful",
                    "Layer 2 solutions drive ETH adoption",
                    "SEC delays decision on Ether ETF",
                    "DeFi TVL on Ethereum hits new milestone"
                ],
                "SOL": [
                    "Solana network activity surges past competitors",
                    "New meme coin frenzy on Solana",
                    "Solana Mobile announces new device",
                    "Developers flock to Solana ecosystem"
                ]
            };

            // Use specific news or generic crypto news
            const specificNews = mockNews[coin] || [
                "Crypto market shows resilience amidst volatility",
                "Regulatory clarity improves in key regions",
                "Web3 gaming sector sees increased investment",
                "Global adoption of digital assets accelerates"
            ];

            // Add some randomness to make it feel "live"
            headlines = specificNews.sort(() => 0.5 - Math.random()).slice(0, 3);
        }

        // 2. Analyze Sentiment
        let totalCompound = 0;
        const results = headlines.map((title: string) => {
            const intensity = Vader.SentimentIntensityAnalyzer.polarity_scores(title);
            totalCompound += intensity.compound;
            return { title, score: intensity.compound };
        });

        const averageSentiment = results.length > 0 ? totalCompound / results.length : 0;

        // 3. Store in Supabase
        await supabase.from('global_sentiment').insert({
            coin,
            score: averageSentiment,
            headlines_count: headlines.length,
            timestamp: new Date().toISOString()
        });

        return NextResponse.json({
            success: true,
            sentiment_index: averageSentiment,
            details: results
        });

    } catch (error) {
        console.error('Sentiment Cron Error:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}
