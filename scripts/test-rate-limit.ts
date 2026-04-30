import { getMetaAndAssetCtxs } from "../lib/hyperliquid-info";

async function testRateLimit() {
    console.log("🚀 Starting Rate Limit Test...");
    const iterations = 20;
    const start = Date.now();
    let successCount = 0;
    let failCount = 0;

    const promises = [];
    for (let i = 0; i < iterations; i++) {
        promises.push(
            getMetaAndAssetCtxs(true)
                .then(res => {
                    if (res) {
                        successCount++;
                        process.stdout.write(".");
                    } else {
                        failCount++;
                        process.stdout.write("x");
                    }
                })
                .catch(err => {
                    failCount++;
                    console.error("Error:", err);
                })
        );
        // Add a tiny delay to simulate rapid firing but not instantaneous
        await new Promise(r => setTimeout(r, 10));
    }

    await Promise.all(promises);
    const duration = Date.now() - start;

    console.log("\n\n📊 Test Results:");
    console.log(`Total Requests: ${iterations}`);
    console.log(`Success: ${successCount}`);
    console.log(`Failed: ${failCount}`);
    console.log(`Total Duration: ${duration}ms`);
    console.log(`Avg Request Time: ${duration / iterations}ms`);

    if (failCount === 0) {
        console.log("✅ Rate Limit Test Passed!");
    } else {
        console.error("❌ Rate Limit Test Failed!");
        process.exit(1);
    }
}

testRateLimit();
