import { marketDbMain, marketDbTest } from '../lib/market-db';

async function enableWal() {
    console.log('Enabling WAL mode for market databases...');

    try {
        await marketDbMain.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
        console.log('✅ Enabled WAL for Mainnet DB');
    } catch (e) {
        console.error('❌ Failed to enable WAL for Mainnet DB', e);
    }

    try {
        await marketDbTest.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
        console.log('✅ Enabled WAL for Testnet DB');
    } catch (e) {
        console.error('❌ Failed to enable WAL for Testnet DB', e);
    }
}

enableWal()
    .catch(console.error)
    .finally(async () => {
        await marketDbMain.$disconnect();
        await marketDbTest.$disconnect();
    });
