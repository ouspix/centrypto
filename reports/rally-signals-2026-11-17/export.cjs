const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PrismaClient: MarketClient } = require('@prisma/market-client');
const { PrismaClient: AppClient } = require('@prisma/app-postgres-client');
const root = path.resolve(__dirname, '../..');
const research = path.join(root, 'data/research/centrypto');
const prior = path.join(research, 'fresh-long-exit-2026-11-16');
const output = path.join(research, path.basename(__dirname));
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json')));
const oldPlan = JSON.parse(fs.readFileSync(path.join(root, 'reports/fresh-long-exit-2026-11-16/plan.json')));
const start = oldPlan.market_end;
const end = plan.market_end;
const offset = (Date.parse(start) - Date.parse(plan.windows[0].start)) / 300000;
const steps = (Date.parse(end) - Date.parse(start)) / 300000;
const market = new MarketClient({datasources: {db: {url: process.env.MARKET_DATABASE_URL}}});
const app = new AppClient({datasources: {db: {url: process.env.DATABASE_URL}}});
function read(file) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); }
function save(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file + '.tmp', zlib.gzipSync(JSON.stringify(value)));
  fs.renameSync(file + '.tmp', file);
}
async function main() {
  const files = fs.readdirSync(path.join(prior, 'market')).filter(f => f.endsWith('.json.gz'));
  for (const [index, file] of files.entries()) {
    const target = path.join(output, 'market', file);
    if (fs.existsSync(target)) continue;
    const previous = read(path.join(prior, 'market', file));
    const symbol = previous.symbol;
    const extra = await market.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const candles = await tx.$queryRaw`
        SELECT "openTime",open,high,low,close,volume FROM "MarketCandle"
        WHERE symbol=${symbol} AND timeframe='1m' AND "openTime">=${start}::timestamp AND "openTime"<${end}::timestamp
        ORDER BY "openTime"`;
      const ticks = await tx.$queryRaw`
        SELECT g.step,t.ts,t."markPrice",t."indexPrice",t."openInterest",t."fundingRate",
          t."volume24h",t."bookBidPx",t."bookAskPx",t."bookBidSz",t."bookAskSz"
        FROM generate_series(0,${steps}::int-1) AS g(step)
        LEFT JOIN LATERAL (
          SELECT * FROM "MarketTick" t WHERE t.symbol=${symbol}
          AND t.ts>=${start}::timestamp+(g.step+1)*INTERVAL '5 minutes'+INTERVAL '5 seconds'-INTERVAL '120 seconds'
          AND t.ts<=${start}::timestamp+(g.step+1)*INTERVAL '5 minutes'+INTERVAL '5 seconds'
          ORDER BY t.ts DESC LIMIT 1
        ) t ON true ORDER BY g.step`;
      return {candles,ticks};
    }, {timeout:45000});
    previous.rows.push(...extra.candles.map(c => [+c.openTime,c.open,c.high,c.low,c.close,c.volume]));
    previous.ticks.push(...extra.ticks.map(t => ({...t,step:t.step+offset})));
    save(target,previous);
    if ((index+1)%30===0) console.log('Market',index+1,'/',files.length);
  }
  const log = path.join(output,'agent-records.json.gz');
  if (!fs.existsSync(log)) {
    const rows = await app.deskRecord.findMany({
      where: {book:{isTestnet:false}, kind:{in:['tool','proposal_revision','candidate_comparison']},
        createdAt:{gte:new Date('2026-11-13T08:30Z'),lt:new Date(plan.windows.at(-1).end)}},
      select:{id:true,kind:true,createdAt:true,dataJson:true},orderBy:{id:'asc'}
    });
    save(log,rows);
    console.log('Mainnet historical observations', rows.length);
  }
}
main().catch(e=>{console.error(e.code||e.name,e.meta?.code);process.exitCode=1;})
  .finally(async()=>{await market.$disconnect();await app.$disconnect();});
