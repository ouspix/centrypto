import { scoreMessage } from '../sentiment/scorer';

async function testModels() {
    console.log('🧪 Testing Sentiment Models...');

    const examples = [
        {
            text: "Bitcoin ETF approval is imminent, analysts say.",
            source: "coindesk",
            expected: "FinBERT",
            language: "en"
        },
        {
            text: "SOL is going to the moon! 🚀🚀🚀",
            source: "twitter",
            expected: "RoBERTa",
            language: "en"
        },
        {
            text: "Just a random comment about nothing.",
            source: "reddit",
            expected: "RoBERTa",
            language: "en"
        },
        {
            text: "Market is crashing hard.",
            source: "news",
            expected: "FinBERT",
            language: "en"
        },
        {
            text: "比特币今日暴涨，突破历史新高！",
            source: "cn_news",
            expected: "FinBERT (via translation)",
            language: "zh"
        },
        {
            text: "这个项目简直是垃圾，完全是骗局。",
            source: "weibo",
            expected: "FinTwitBERT (via translation)",
            language: "zh"
        },
        {
            text: "市场情绪低迷，恐慌指数上升。",
            source: "cn_blockbeats",
            expected: "FinBERT (via translation)",
            language: "zh"
        }
    ];

    for (const ex of examples) {
        console.log(`\n--- Testing [${ex.expected}] routing ---`);
        console.log(`Input: "${ex.text}" (Source: ${ex.source}, Lang: ${ex.language})`);
        const start = Date.now();
        const result = await scoreMessage(ex.text, { source: ex.source, language: ex.language });
        const duration = Date.now() - start;
        console.log(`Result: Score=${result.score.toFixed(3)}, Conf=${result.confidence}, Model=${result.model}`);
        console.log(`Time: ${duration}ms`);
    }
}

testModels().catch(console.error);
