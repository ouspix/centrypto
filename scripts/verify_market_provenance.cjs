const { PrismaClient } = require('@prisma/market-client');
async function verify(url, label) {
  const db=new PrismaClient({datasources:{db:{url}},log:[]});
  try {
    const observations=await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS observations,COUNT(DISTINCT symbol)::int AS symbols,MIN("receivedAt") AS first_receipt,MAX("receivedAt") AS latest_receipt,COUNT(*) FILTER (WHERE "receivedAt">"recordedAt"+INTERVAL '1 second')::int AS clock_violations FROM "MarketCandleObservation"`);
    const ticks=await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS received_ticks,COUNT("bookReceivedAt")::int AS received_books,MAX("receivedAt") AS latest_receipt FROM "MarketTick" WHERE ts>NOW()-INTERVAL '10 minutes' AND "receivedAt" IS NOT NULL`);
    const access=await db.$queryRawUnsafe(`SELECT has_table_privilege('centrypto_market','"MarketCandleObservation"','INSERT') AS collector_insert,has_table_privilege('centrypto_market','"MarketCandleObservation"','UPDATE') AS collector_update,has_table_privilege('centrypto_market','"MarketCandleObservation"','DELETE') AS collector_delete,has_table_privilege('centrypto_app','"MarketCandleObservation"','SELECT') AS app_read`);
    return {label,observations:observations[0],ticks:ticks[0],access:access[0]};
  } finally {await db.$disconnect();}
}
Promise.all([verify(process.env.MARKET_DATABASE_URL,'mainnet'),verify(process.env.MARKET_TEST_DATABASE_URL,'testnet')]).then(rows=>console.log(JSON.stringify(rows,null,2))).catch(error=>{console.error(error.code||error.name);process.exitCode=1;});
