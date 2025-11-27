
process.env.DATABASE_URL = "file:" + require('path').join(process.cwd(), 'prisma', 'backend.db');
import { prisma } from "../lib/db";

async function main() {
    const history = await prisma.llmQuery.findMany({
        include: {
            decisions: true
        },
        orderBy: {
            createdAt: 'desc'
        },
        take: 5
    });

    console.log(`Found ${history.length} records.`);

    for (const record of history) {
        console.log("---------------------------------------------------");
        console.log(`ID: ${record.id}`);
        console.log(`Created At: ${record.createdAt}`);
        console.log(`Prompt Length: ${record.prompt.length}`);
        console.log(`Response Length: ${record.response.length}`);
        console.log(`Decisions Count: ${record.decisions.length}`);
        console.log("Response Preview:");
        console.log(record.response.substring(0, 500)); // Print first 500 chars
        console.log("Decisions:");
        console.log(JSON.stringify(record.decisions, null, 2));
    }
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
