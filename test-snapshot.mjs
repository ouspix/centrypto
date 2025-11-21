// Test snapshot generation
import { SnapshotBuilder } from './services/SnapshotBuilder.js';

const testSnapshot = async () => {
    console.log('🧪 Testing SnapshotBuilder...\n');

    const builder = new SnapshotBuilder();
    const snapshot = await builder.buildSnapshot(null, true);

    console.log('📦 Generated Snapshot:');
    console.log(JSON.stringify(snapshot, null, 2));

    console.log('\n📊 Markets count:', Object.keys(snapshot.markets).length);
    console.log('📊 Market symbols:', Object.keys(snapshot.markets));
};

testSnapshot().catch(console.error);
