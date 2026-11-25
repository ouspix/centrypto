// Read-only PostgreSQL fallback: do not rely on the damaged local SQLite archive.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {PrismaClient}=require('@prisma/market-client');const db=new PrismaClient({datasources:{db:{url:process.env.MARKET_DATABASE_URL}}});
const dir=__dirname,spec=JSON.parse(fs.readFileSync(path.join(dir,'spec.json'))),cache=JSON.parse(fs.readFileSync(path.join(dir,'paths.json'))).external_linux;
async function main(){
 const manifest={source:'Read-only mainnet PostgreSQL MarketCandle. Older SQLite source reported corruption; these files replace its partial exports.',exportedAt:new Date().toISOString(),periods:{}};
 for(const period of spec.periods.slice(0,2)){
  const when={gte:new Date(period.start),lt:new Date(period.end)};
  const symbols=(await db.marketCandle.findMany({where:{timeframe:'1m',openTime:when},distinct:['symbol'],select:{symbol:true},orderBy:{symbol:'asc'}})).map(r=>r.symbol).filter(s=>!s.includes(':')&&!s.includes('@'));
  let cursor=0;const items=[];
  async function worker(){while(cursor<symbols.length){const symbol=symbols[cursor++];const rows=await db.marketCandle.findMany({where:{symbol,timeframe:'1m',openTime:when},select:{openTime:true,open:true,high:true,low:true,close:true,volume:true},orderBy:{openTime:'asc'}});const data={symbol,columns:['time_ms','open','high','low','close','base_volume'],rows:rows.map(r=>[+r.openTime,r.open,r.high,r.low,r.close,r.volume])};const bytes=zlib.gzipSync(JSON.stringify(data));const file=path.join(cache,'candles',period.id,encodeURIComponent(symbol)+'.json.gz');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);items.push({symbol,rows:rows.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});if(items.length%50===0)console.log(period.id,items.length,'/',symbols.length);}}
  await Promise.all([worker(),worker(),worker()]);items.sort((a,b)=>a.symbol.localeCompare(b.symbol));manifest.periods[period.id]=items;console.log(period.id,'rows',items.reduce((s,r)=>s+r.rows,0));
  fs.writeFileSync(path.join(dir,'older-manifest.json'),JSON.stringify(manifest,null,2));
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>db.$disconnect());
