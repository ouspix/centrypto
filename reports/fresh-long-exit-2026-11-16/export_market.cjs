// Export only the fresh tail. The replay uses the original immutable archive for warmup.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PrismaClient } = require('@prisma/market-client');

const root = path.resolve(__dirname, '../..');
const research = path.join(root, 'data/research/centrypto');
const source = path.join(root, 'reports/two-stage-policy-2026-11-14');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json')));
const output = path.join(research, path.basename(__dirname));
const catalog = JSON.parse(fs.readFileSync(path.join(source, 'catalog.json')));
const contracts = catalog.filter(row => row.period === 'recent').map(row => row.symbol);
const start = config.entry_windows[0].start;
const end = config.market_end;
const steps = (Date.parse(end) - Date.parse(start)) / 300_000;
const db = new PrismaClient({ datasources: { db: { url: process.env.MARKET_DATABASE_URL } } });

async function readSnapshot(symbol) {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='35s'");
    const candles = await tx.$queryRaw`
      SELECT "openTime", open, high, low, close, volume
      FROM "MarketCandle"
      WHERE symbol = ${symbol} AND timeframe = '1m'
        AND "openTime" >= ${start}::timestamp AND "openTime" < ${end}::timestamp
      ORDER BY "openTime"`;
    const ticks = await tx.$queryRaw`
      SELECT g.step, t.ts, t."markPrice", t."indexPrice", t."openInterest", t."fundingRate",
             t."volume24h", t."bookBidPx", t."bookAskPx", t."bookBidSz", t."bookAskSz"
      FROM generate_series(0, ${steps}::int - 1) AS g(step)
      CROSS JOIN LATERAL (
        SELECT ${start}::timestamp + (g.step + 1) * INTERVAL '5 minutes' + INTERVAL '5 seconds' AS cut
      ) AS c
      LEFT JOIN LATERAL (
        SELECT * FROM "MarketTick" t
        WHERE t.symbol = ${symbol} AND t.ts >= c.cut - INTERVAL '120 seconds' AND t.ts <= c.cut
        ORDER BY t.ts DESC LIMIT 1
      ) AS t ON true
      ORDER BY g.step`;
    return { symbol, rows: candles.map(c => [+c.openTime, c.open, c.high, c.low, c.close, c.volume]), ticks };
  }, { timeout: 45_000 });
}

async function main() {
  const folder = path.join(output, 'market');
  fs.mkdirSync(folder, { recursive: true });
  let next = 0;
  let completed = 0;
  async function exportSymbols() {
    while (next < contracts.length) {
      const symbol = contracts[next++];
      const file = path.join(folder, encodeURIComponent(symbol) + '.json.gz');
      if (!fs.existsSync(file)) {
        const snapshot = await readSnapshot(symbol);
        fs.writeFileSync(file + '.tmp', zlib.gzipSync(JSON.stringify(snapshot)));
        fs.renameSync(file + '.tmp', file);
      }
      if (++completed % 30 === 0) console.log('Contracts exported', completed, '/', contracts.length);
    }
  }
  await Promise.all([exportSymbols(), exportSymbols()]);
  console.log('Contracts exported', completed, '/', contracts.length);
}

main().catch(error => {
  console.error(error.code || error.name, error.meta?.code, error.meta?.message);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
