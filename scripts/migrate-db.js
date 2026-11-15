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
