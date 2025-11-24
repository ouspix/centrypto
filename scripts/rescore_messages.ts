import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { prisma } from '../lib/db';
import { scoreMessage } from '../sentiment/scorer';
import { tagMessage } from '../sentiment/tagger';

async function rescoreMessages() {
    console.log("🔄 Starting Message Re-scoring...");

    // 1. Fetch messages from the last 24 hours (or all if needed, but 24h is usually enough for immediate impact)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    console.log(`📅 Fetching messages since ${since.toISOString()}...`);

    const messages = await prisma.message.findMany({
        where: {
            ts: { gte: since }
        },
        orderBy: { ts: 'desc' }
    });

    console.log(`found ${messages.length} messages to re-score.`);

    let updatedCount = 0;
    const batchSize = 50;

    // Process in chunks to avoid overwhelming the model/DB
    for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        console.log(`Processing batch ${i / batchSize + 1}/${Math.ceil(messages.length / batchSize)}...`);

        const updates = await Promise.all(batch.map(async (msg) => {
            try {
                const { score, confidence } = await scoreMessage(msg.text, {
                    source: msg.source,
                    language: (msg as any).language as 'en' | 'zh' | undefined,
                });

                // Also re-tag while we're at it
                const tags = tagMessage(msg.text, ((msg as any).language as 'en' | 'zh') ?? 'en');

                return prisma.message.update({
                    where: { id: msg.id },
                    data: {
                        sentimentScore: score,
                        sentimentConf: confidence,
                        tagsJson: JSON.stringify(tags),
                    }
                });
            } catch (err) {
                console.error(`Failed to score message ${msg.id}:`, err);
                return null;
            }
        }));

        updatedCount += updates.filter(u => u !== null).length;
    }

    console.log(`✅ Re-scoring complete. Updated ${updatedCount} messages.`);
}

rescoreMessages()
    .catch(console.error)
    .finally(async () => {
        await prisma.$disconnect();
    });
