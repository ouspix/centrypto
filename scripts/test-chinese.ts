import { scoreMessage } from '../sentiment/scorer';

async function testChinese() {
    console.log('🇨🇳 Testing Chinese Sentiment (Lexicon-based)...');

    const examples = [
        {
            text: "比特币今日暴涨，突破历史新高！", // Bitcoin skyrocketed today, breaking ATH! (Obvious Positive)
            expected: "Positive"
        },
        {
            text: "市场情绪低迷，恐慌指数上升。", // Market sentiment is low, fear index rising. (Obvious Negative)
            expected: "Negative"
        },
        {
            text: "虽然价格下跌，但是交易量在增加，可能是吸筹。", // Although price dropped, volume is increasing, might be accumulation. (Nuanced/Mixed)
            expected: "Positive/Neutral"
        },
        {
            text: "这个项目简直是垃圾，完全是骗局。", // This project is trash, total scam. (Slang/Strong Negative)
            expected: "Negative"
        },
        {
            text: "不要买，快跑！", // Don't buy, run! (Imperative/Contextual)
            expected: "Negative"
        }
    ];

    for (const ex of examples) {
        console.log(`\nInput: "${ex.text}"`);
        console.log(`Expected: ${ex.expected}`);
        const result = await scoreMessage(ex.text, { source: 'cn_news', language: 'zh' });
        console.log(`Result: Score=${result.score.toFixed(3)}, Conf=${result.confidence}`);
    }
}

testChinese().catch(console.error);
