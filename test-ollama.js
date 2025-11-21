// Updated test script with new prompt format
const testModel = async (modelName) => {
    const snapshot = {
        account: { equity: 10000 },
        markets: { 'BTC-PERP': { price: 50000 } }
    };

    const systemPrompt = `You are a TraderAgent AI. Analyze the market snapshot and output a trading decision as JSON.

MARKET SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}

TASK: Based on the snapshot above, decide on a trading action.

REQUIRED OUTPUT: A single JSON object with these exact fields:
- action: Must be one of: "OPEN_POSITION", "CLOSE_POSITION", "REDUCE_POSITION", "ADJUST_STOPS", "DO_NOTHING"
- symbol: "BTC-PERP", "ETH-PERP", or null
- side: "long", "short", or null
- size_fraction_of_equity: A number between 0.0 and 1.0, or null
- risk_plan: An object with "stop_loss_pct" and "take_profit_pct_primary" (both numbers), or null
- playbook: One of: "trend_follow_pullback", "mean_reversion", "breakout", "hedge", "liquidity_exit", "none"
- confidence: A number between 0.0 and 1.0
- reason_code: A short code like "trend_follow", "fade_extreme_sentiment", "no_trade", etc.
- notes: A brief explanation (1-2 sentences)

OUTPUT ONLY THE JSON. NO EXPLANATION. NO MARKDOWN. NO CODE BLOCKS.

Example valid output:
{"action":"DO_NOTHING","symbol":null,"side":null,"size_fraction_of_equity":null,"risk_plan":null,"playbook":"none","confidence":0.5,"reason_code":"no_trade","notes":"Insufficient data to make a decision."}`;

    try {
        console.log(`\n🧪 Testing model: ${modelName}`);
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                prompt: systemPrompt,
                stream: false,
                format: 'json',
                options: {
                    temperature: 0.3,
                    top_p: 0.9
                }
            })
        });

        if (!response.ok) {
            console.error(`❌ HTTP Error: ${response.status}`);
            return;
        }

        const data = await response.json();
        console.log('📦 Raw response (first 200 chars):', data.response.substring(0, 200));

        // Try to parse with the same logic as the service
        try {
            let jsonStr = data.response.trim();

            if (jsonStr.includes('```')) {
                const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                if (match) {
                    jsonStr = match[1].trim();
                } else {
                    const firstBrace = jsonStr.indexOf('{');
                    const lastBrace = jsonStr.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1) {
                        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
                    }
                }
            }

            const parsed = JSON.parse(jsonStr);
            console.log('✅ Successfully parsed!');
            console.log('   Action:', parsed.action);
            console.log('   Confidence:', parsed.confidence);
            console.log('   Notes:', parsed.notes?.substring(0, 50) + '...');
        } catch (e) {
            console.error('❌ Parse error:', e.message);
            console.log('   Attempted to parse:', jsonStr.substring(0, 100));
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
};

// Test multiple models
(async () => {
    await testModel('llama3.1:8b');
    await testModel('qwen3:14b');
    await testModel('deepseek-r1:14b');
})();
