
import fetch from 'node-fetch';

async function main() {
    console.log("Triggering analysis...");
    const response = await fetch('http://localhost:3000/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            isManual: true,
            isTestnet: true,
            model: "deepseek/deepseek-chat", // Try a standard model
            configOverride: {
                triggers: {
                    momentum: { book_pressure_min: 0.05, vol_ratio_min: 0.5 },
                    mean_reversion: { ret_sigma_threshold: 2.0, book_pressure_min: 0.05 },
                    breakout: { vol_ratio_min: 1.5, book_pressure_min: 0.1 }
                }
            }
        })
    });

    if (!response.ok) {
        console.error("Failed to trigger analysis:", await response.text());
        return;
    }

    const data = await response.json();
    console.log("Analysis triggered:", data);

    if (data.jobId) {
        console.log("Waiting for job completion...");
        let jobResult = null;
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const statusRes = await fetch(`http://localhost:3000/api/ai/job-status?jobId=${data.jobId}`);
            const statusData = await statusRes.json();
            if (statusData.status === 'completed') {
                jobResult = statusData.result;
                break;
            }
            if (statusData.status === 'failed') {
                console.error("Job failed:", statusData.error);
                break;
            }
        }

        if (jobResult) {
            console.log("Job Completed.");
            const snapshot = jobResult.snapshot;
            if (snapshot && snapshot.markets) {
                const firstMarket = Object.values(snapshot.markets)[0] as any;
                if (firstMarket) {
                    console.log("First Market Triggers:", JSON.stringify(firstMarket.derived.triggers, null, 2));
                    console.log("First Market Normalized:", JSON.stringify(firstMarket.derived.normalized, null, 2));
                    console.log("First Market Book Pressure:", firstMarket.orderbook.book_pressure);
                }
            }
        } else {
            console.log("Job timed out or failed.");
        }
    }
}

main().catch(console.error);
