const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {PrismaClient}=require('@prisma/market-client');const db=new PrismaClient({datasources:{db:{url:process.env.MARKET_DATABASE_URL}}});
const dir=__dirname,cache=JSON.parse(fs.readFileSync(path.join(dir,'paths.json'))).external_linux;
const lines=fs.readFileSync(path.join(dir,'trades.csv'),'utf8').trim().split(/\r?\n/),header=lines.shift().split(',');
const entries=lines.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[header[i],v]))).filter(r=>r.slippage_bps_per_side==='0').map(r=>({key:r.key,symbol:r.symbol,cutoff:new Date(Date.parse(r.entry_time)-5000).toISOString()}));
const previous=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(dir,'../rally-model-2026-11-13/ticks.json.gz'))));
const found=new Map(previous.map(r=>[r.key,r]));
async function main(){
 const out=entries.map(e=>found.get(e.key)||{...e,recent:[],anchors:{15:null,60:null,240:null,1440:null}}),bykey=new Map(out.map(r=>[r.key,r]));const missing=entries.filter(e=>!found.has(e.key));
 for(let start=0;start<missing.length;start+=30){
  const batch=missing.slice(start,start+30),parameter=JSON.stringify(batch.map(e=>({skey:e.key,symbol:e.symbol,cutoff:e.cutoff})));
  const recent=await db.$queryRawUnsafe(`WITH entries AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS e(skey text,symbol text,cutoff text)) SELECT e.skey AS "key",t.* FROM entries e JOIN LATERAL (SELECT * FROM "MarketTick" t WHERE t.symbol=e.symbol AND t.ts >= e.cutoff::timestamp - INTERVAL '15 minutes' AND t.ts <= e.cutoff::timestamp ORDER BY t.ts) t ON true`,parameter);
  for(const row of recent){const {key,...tick}=row;bykey.get(key).recent.push(tick);}
  const anchors=await db.$queryRawUnsafe(`WITH entries AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS e(skey text,symbol text,cutoff text)) SELECT e.skey AS "key",lag.minutes,t.* FROM entries e CROSS JOIN (VALUES (15),(60),(240),(1440)) AS lag(minutes) LEFT JOIN LATERAL (SELECT * FROM "MarketTick" t WHERE t.symbol=e.symbol AND t.ts >= e.cutoff::timestamp - lag.minutes*INTERVAL '1 minute' - INTERVAL '120 seconds' AND t.ts <= e.cutoff::timestamp - lag.minutes*INTERVAL '1 minute' ORDER BY t.ts DESC LIMIT 1) t ON true`,parameter);
  for(const row of anchors){const {key,minutes,...tick}=row;bykey.get(key).anchors[minutes]=tick.ts?tick:null;}
  if(start%150===0)console.log('Derivative contexts',Math.min(start+30,missing.length),'/',missing.length);
 }
 const bytes=zlib.gzipSync(JSON.stringify(out));fs.writeFileSync(path.join(cache,'ticks-expanded.json.gz'),bytes);const manifest={exportedAt:new Date().toISOString(),entries:out.length,reused:entries.length-missing.length,rows:out.reduce((s,r)=>s+r.recent.length+Object.values(r.anchors).filter(Boolean).length,0),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};fs.writeFileSync(path.join(dir,'context-manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>db.$disconnect());
