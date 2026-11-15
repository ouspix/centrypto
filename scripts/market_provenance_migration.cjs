/** Additive migration with a short lock timeout; never assigns dates to old rows. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/market-client');
const access = process.argv.includes('--access');
const migration = access ? '20261115083500_observation_access' : '20261115083000_observation_provenance';
const sql = fs.readFileSync(path.join(__dirname, '../prisma/runtime-market/migrations', migration, 'migration.sql'), 'utf8');
const url = new URL(process.argv.includes('--test') ? process.env.MARKET_TEST_DATABASE_URL : process.env.MARKET_DATABASE_URL);
if (process.argv.includes('--admin')) {
  const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/deployment/vps-credentials.json'), 'utf8'));
  url.username = 'centrypto_admin'; url.password = credentials.admin;
}
const db = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
async function inspect(client) {
  const columns = await client.$queryRawUnsafe(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='MarketTick' AND column_name IN ('receivedAt','bookEventAt','bookReceivedAt','source')) OR (table_name='MarketCandle' AND column_name='receivedAt'))`);
  const tables = await client.$queryRawUnsafe(`SELECT to_regclass(format('%I.%I',current_schema(),'MarketCandleObservation'))::text AS observations, to_regclass(format('%I.%I',current_schema(),'_prisma_migrations'))::text AS migrations`);
  return { addedColumns: columns.length, observationTable: Boolean(tables[0].observations), migrationLedger: Boolean(tables[0].migrations) };
}
async function main() {
  const before = await inspect(db);
  if (!process.argv.includes('--apply')) { console.log(JSON.stringify({ mode: 'check', ...before })); return; }
  if (!access && before.addedColumns === 5 && before.observationTable) { console.log(JSON.stringify({ status: 'already_applied', ...before })); return; }
  if (!access && (before.addedColumns || before.observationTable)) throw new Error('Partial schema detected; inspect before applying');
  if (access && !before.observationTable) throw new Error('Apply the provenance schema first');
  if (access && before.migrationLedger) {
    const applied = await db.$queryRawUnsafe(`SELECT id FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, migration);
    if (applied.length) { console.log(JSON.stringify({status:'already_applied',migration})); return; }
  }
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '10000ms'`);
    for (const statement of sql.split(';').map(s=>s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
    if (before.migrationLedger) {
      await tx.$executeRawUnsafe(`INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,NOW(),$3,NOW(),1)`, crypto.randomUUID(), crypto.createHash('sha256').update(sql).digest('hex'), migration);
    }
  }, { timeout: 20000 });
  const after = await inspect(db);
  if (after.addedColumns !== 5 || !after.observationTable) throw new Error('Post-migration verification failed');
  console.log(JSON.stringify({ status: 'applied', migration, before, after, historicalDatesBackfilled: false }));
}
main().catch(error=>{ console.error(JSON.stringify({ status:'failed', code:error.code || null, message: String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]') })); process.exitCode=1; }).finally(()=>db.$disconnect());
