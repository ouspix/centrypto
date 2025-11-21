import Vader from 'vader-sentiment';

export type SentimentResult = {
    score: number;
    change_2h: number;
    mentions_vs_baseline: number;
    disagreement: number;
};

export class SentimentService {
    private apiKey: string | undefined;

    constructor() {
        this.apiKey = process.env.CRYPTOPANIC_API_KEY;
    }

    public async getSentimentForCoin(coin: string): Promise<SentimentResult> {
        try {
            let headlines: string[] = [];

            if (this.apiKey) {
                try {
                    const response = await fetch(`https://cryptopanic.com/api/v1/posts/?auth_token=${this.apiKey}&currencies=${coin}&public=true`);
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
                headlines = this.getMockHeadlines(coin);
            }

            // Analyze Sentiment
            let totalCompound = 0;
            const scores: number[] = [];

            headlines.forEach((title: string) => {
                const intensity = Vader.SentimentIntensityAnalyzer.polarity_scores(title);
                totalCompound += intensity.compound;
                scores.push(intensity.compound);
            });

            const averageSentiment = scores.length > 0 ? totalCompound / scores.length : 0;

            // Calculate disagreement (standard deviation of scores)
            const variance = scores.length > 0
                ? scores.reduce((sum, score) => sum + Math.pow(score - averageSentiment, 2), 0) / scores.length
                : 0;
            const disagreement = Math.sqrt(variance);

            return {
                score: averageSentiment,
                change_2h: 0, // Placeholder: would need historical data
                mentions_vs_baseline: 1.0, // Placeholder
                disagreement: disagreement
            };

        } catch (error) {
            console.error('Sentiment Service Error:', error);
            return {
                score: 0,
                change_2h: 0,
                mentions_vs_baseline: 1.0,
                disagreement: 0
            };
        }
    }

    private getMockHeadlines(coin: string): string[] {
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

        const specificNews = mockNews[coin] || [
            "Crypto market shows resilience amidst volatility",
            "Regulatory clarity improves in key regions",
            "Web3 gaming sector sees increased investment",
            "Global adoption of digital assets accelerates"
        ];

        // Add some randomness
        return specificNews.sort(() => 0.5 - Math.random()).slice(0, 3);
    }
}
