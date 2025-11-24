import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { runFullPipeline } from "../sentiment/pipeline";
import { prisma } from "../lib/db";

// Default to 15 minutes to avoid hammering flaky RSS endpoints; override with env if needed
const INTERVAL_MS = parseInt(process.env.SENTIMENT_INTERVAL_MS || `${15 * 60 * 1000}`, 10);

async function runLoop() {
    console.log("🚀 Starting Standalone Sentiment Service...");
    console.log(`⏱️ Sentiment pipeline interval set to ${INTERVAL_MS / 1000}s`);

    while (true) {
        try {
            console.log(`\n[${new Date().toISOString()}] 🧠 Running Sentiment Pipeline...`);
            await runFullPipeline();
            console.log("✅ Sentiment pipeline cycle completed.");
        } catch (error) {
            console.error("❌ Sentiment pipeline cycle failed:", error);
        }

        console.log(`💤 Sleeping for ${INTERVAL_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log("🛑 Shutting down Sentiment Service...");
    await prisma.$disconnect();
    process.exit(0);
});

runLoop();
