const { PrismaClient } = require('@prisma/client');
const path = require('path');

async function migrateData() {
    // Source database (dev.db)
    const sourcePrisma = new PrismaClient({
        datasources: {
            db: {
                url: `file:${path.join(__dirname, '../prisma/dev.db')}`
            }
        }
    });

    // Target database (backend.db)
    const targetPrisma = new PrismaClient({
        datasources: {
            db: {
                url: `file:${path.join(__dirname, '../prisma/backend.db')}`
            }
        }
    });

    try {
        console.log('Starting data migration from dev.db to backend.db...');
        console.log('(Skipping Candle table - stored in separate market data DBs)');

        // Migrate MarketStateSnapshots
        console.log('\\nMigrating MarketStateSnapshots...');
        const marketSnapshots = await sourcePrisma.marketStateSnapshot.findMany();
        for (const snapshot of marketSnapshots) {
            await targetPrisma.marketStateSnapshot.upsert({
                where: { id: snapshot.id },
                update: snapshot,
                create: snapshot
            });
        }
        console.log(`✓ Migrated ${marketSnapshots.length} market snapshots`);

        // Migrate Messages
        console.log('Migrating Messages...');
        const messages = await sourcePrisma.message.findMany();
        let msgCount = 0;
        for (const message of messages) {
            await targetPrisma.message.upsert({
                where: { id: message.id },
                update: message,
                create: message
            });
            msgCount++;
            if (msgCount % 100 === 0) {
                console.log(`  ... ${msgCount}/${messages.length}`);
            }
        }
        console.log(`✓ Migrated ${messages.length} messages`);

        // Migrate PriceAlerts
        console.log('Migrating PriceAlerts...');
        const alerts = await sourcePrisma.priceAlert.findMany();
        for (const alert of alerts) {
            await targetPrisma.priceAlert.upsert({
                where: { id: alert.id },
                update: alert,
                create: alert
            });
        }
        console.log(`✓ Migrated ${alerts.length} price alerts`);

        // Migrate ScreeningSnapshots
        console.log('Migrating ScreeningSnapshots...');
        const screeningSnapshots = await sourcePrisma.screeningSnapshot.findMany();
        for (const snapshot of screeningSnapshots) {
            await targetPrisma.screeningSnapshot.upsert({
                where: { id: snapshot.id },
                update: snapshot,
                create: snapshot
            });
        }
        console.log(`✓ Migrated ${screeningSnapshots.length} screening snapshots`);

        // Migrate SymbolBaselines
        console.log('Migrating SymbolBaselines...');
        const baselines = await sourcePrisma.symbolBaseline.findMany();
        for (const baseline of baselines) {
            await targetPrisma.symbolBaseline.upsert({
                where: { id: baseline.id },
                update: baseline,
                create: baseline
            });
        }
        console.log(`✓ Migrated ${baselines.length} symbol baselines`);

        // Migrate SymbolSentimentSnapshots
        console.log('Migrating SymbolSentimentSnapshots...');
        const sentimentSnapshots = await sourcePrisma.symbolSentimentSnapshot.findMany();
        let sentCount = 0;
        for (const snapshot of sentimentSnapshots) {
            await targetPrisma.symbolSentimentSnapshot.upsert({
                where: { id: snapshot.id },
                update: snapshot,
                create: snapshot
            });
            sentCount++;
            if (sentCount % 100 === 0) {
                console.log(`  ... ${sentCount}/${sentimentSnapshots.length}`);
            }
        }
        console.log(`✓ Migrated ${sentimentSnapshots.length} sentiment snapshots`);

        // Migrate Trades
        console.log('Migrating Trades...');
        const trades = await sourcePrisma.trade.findMany();
        for (const trade of trades) {
            await targetPrisma.trade.upsert({
                where: { id: trade.id },
                update: trade,
                create: trade
            });
        }
        console.log(`✓ Migrated ${trades.length} trades`);

        console.log('\\n✅ Migration completed successfully!');
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await sourcePrisma.$disconnect();
        await targetPrisma.$disconnect();
    }
}

migrateData();
