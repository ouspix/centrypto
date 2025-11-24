import { prisma } from '../lib/db';

async function verifyScores() {
    console.log("🔍 Verifying scores...");
    const messages = await prisma.message.findMany({
        take: 5,
        orderBy: { ts: 'desc' },
        select: {
            source: true,
            text: true,
            sentimentScore: true,
            sentimentConf: true
        }
    });

    console.log(JSON.stringify(messages, null, 2));
}

verifyScores()
    .catch(console.error)
    .finally(async () => {
        await prisma.$disconnect();
    });
