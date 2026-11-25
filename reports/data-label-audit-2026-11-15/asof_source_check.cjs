const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {PrismaClient}=require('@prisma/market-client');const db=new PrismaClient({datasources:{db:{url:process.env.MARKET_DATABASE_URL}}});
async function main(){
 const liq=JSON.parse(fs.readFileSync(path.join(__dirname,'liquidity.json'))),catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../two-stage-policy-2026-11-14/catalog.json')));
 const cache=JSON.parse(fs.readFileSync(path.join(__dirname,'../two-stage-policy-2026-11-14/paths.json'))).external_linux;const checks=[];
 const selected=[...liq.series.filter(r=>r.usable_book>0).slice(0,4),...liq.series.filter(r=>r.period==='mayjun'&&r.matched_ticks>0).slice(0,4)];
 for(const item of selected){const cat=catalog.find(c=>c.key===item.key),rows=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cache,'ticks',item.key+'.json.gz'))));const r=rows.find(r=>item.usable_book?r.bookBidSz>0:r.ts);const cut=new Date(+new Date(cat.start)+(r.step+1)*300000+5000);
 const latest=await db.$queryRawUnsafe('SELECT ts,"markPrice","indexPrice","openInterest","fundingRate","volume24h","bookBidPx","bookBidSz","bookAskPx","bookAskSz" FROM "MarketTick" WHERE symbol=$1 AND ts>=$2::timestamp-INTERVAL \'120 seconds\' AND ts<=$2::timestamp ORDER BY ts DESC LIMIT 1',cat.symbol,cut.toISOString());
 const cols=['markPrice','indexPrice','openInterest','fundingRate','volume24h','bookBidPx','bookBidSz','bookAskPx','bookAskSz'];const match=latest.length===1&&+latest[0].ts===+new Date(r.ts)&&cols.every(k=>latest[0][k]===r[k]);checks.push({symbol:cat.symbol,decision:cut.toISOString(),exportedTickTime:r.ts,dbTickTime:latest[0]?.ts,fieldsCompared:cols.length,match});
 }
 fs.writeFileSync(path.join(__dirname,'asof-source-check.json'),JSON.stringify({checks,allMatch:checks.every(r=>r.match),scope:'Eight sampled latest-tick joins compared directly with source DB; publication time is not separately recorded.'},null,2));console.log(JSON.stringify({checks:checks.length,allMatch:checks.every(r=>r.match)}));
}
main().catch(e=>{console.log(JSON.stringify({code:e.code||e.name}));process.exitCode=1}).finally(()=>db.$disconnect());
