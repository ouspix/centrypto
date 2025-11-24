import { prisma } from '../lib/db';

async function checkRescoreStatus() {
    console.log("📊 Checking re-score status...\n");

    const stats = await prisma.message.aggregate({
        _count: { id: true },
        _min: { ts: true },
        _max: { ts: true },
    });

    const scoredCount = await prisma.message.count({
        where: { sentimentScore: { not: null } }
    });

    const recentScored = await prisma.message.count({
        where: {
            sentimentScore: { not: null },
            ts: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }
    });

    console.log(`Total messages: ${stats._count.id}`);
    console.log(`Scored messages: ${scoredCount} (${((scoredCount / stats._count.id) * 100).toFixed(1)}%)`);
    console.log(`Recent (24h) scored: ${recentScored}`);
    console.log(`Date range: ${stats._min.ts?.toISOString()} → ${stats._max.ts?.toISOString()}`);

    // Sample recent messages
    console.log("\n📝 Sample of recent scored messages:");
    const samples = await prisma.message.findMany({
        where: { sentimentScore: { not: null } },
        orderBy: { ts: 'desc' },
        take: 5,
        select: {
            source: true,
            text: true,
            sentimentScore: true,
            sentimentConf: true,
            ts: true
        }
    });

    samples.forEach(msg => {
        console.log(`\n[${msg.source}] ${msg.ts.toISOString()}`);
        console.log(`Text: ${msg.text.substring(0, 60)}...`);
        console.log(`Score: ${msg.sentimentScore?.toFixed(3)}, Conf: ${msg.sentimentConf?.toFixed(3)}`);
    });
}

checkRescoreStatus()
    .catch(console.error)
    .finally(async () => {
        await prisma.$disconnect();
    });
