const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {PrismaClient:M}=require('@prisma/market-client'),{PrismaClient:N}=require('@prisma/news-client');
const m=new M({datasources:{db:{url:process.env.MARKET_DATABASE_URL}}}),n=new N({datasources:{db:{url:process.env.NEWS_DATABASE_URL}}});
const dir=__dirname,cache=JSON.parse(fs.readFileSync(path.join(dir,'paths.json'))).external_linux,ownerAddress=process.env.NEWS_COLLECTOR_OWNER_ADDRESS?.trim().toLowerCase();
if(!ownerAddress)throw Error('News account namespace unavailable');
function save(file,data){const bytes=zlib.gzipSync(JSON.stringify(data));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return {file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};}
async function main(){
 const when={gte:new Date('2026-11-13T00:00:00Z'),lt:new Date('2026-11-13T20:00:00Z')};
 const symbols=(await m.marketCandle.findMany({where:{timeframe:'1m',openTime:when},distinct:['symbol'],select:{symbol:true},orderBy:{symbol:'asc'}})).map(r=>r.symbol);
 const items=[];
 for(const symbol of symbols){
  const file=path.join(cache,'candles','nov13',encodeURIComponent(symbol)+'.json.gz');let data;
  if(fs.existsSync(file))data=JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  else {const rows=await m.marketCandle.findMany({where:{symbol,timeframe:'1m',openTime:when},select:{openTime:true,open:true,high:true,low:true,close:true,volume:true},orderBy:{openTime:'asc'}});data={symbol,columns:['time_ms','open','high','low','close','base_volume'],rows:rows.map(r=>[+r.openTime,r.open,r.high,r.low,r.close,r.volume])};save(file,data);}
  items.push({symbol,rows:data.rows.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
 }
 const end=new Date('2026-11-13T20:00:00Z');
 const [documents,analyses,revisions]=await Promise.all([
  n.newsDocument.findMany({where:{ownerAddress,availableAt:{lt:end}},select:{id:true,externalId:true,revisionHash:true,storyHash:true,canonicalUrl:true,text:true,publishedAt:true,collectedAt:true,availableAt:true,source:{select:{id:true,name:true,url:true,isPrivate:true}}},orderBy:{availableAt:'asc'}}),
  n.newsAnalysis.findMany({where:{ownerAddress,availableAt:{lt:end}},select:{id:true,availableAt:true,resultJson:true,model:true},orderBy:{availableAt:'asc'}}),
  n.newsEventRevision.findMany({where:{ownerAddress,availableAt:{lt:end}},select:{id:true,eventKey:true,analysisId:true,material:true,availableAt:true,detailsJson:true},orderBy:{availableAt:'asc'}})
 ]);
 const newsFile=save(path.join(cache,'news-full.json.gz'),{documents,analyses,revisions});
 const manifest={exportedAt:new Date().toISOString(),recent:{start:when.gte,end:when.lt,symbols:items},news:{...newsFile,documents:documents.length,analyses:analyses.length,revisions:revisions.length,first:documents[0]?.availableAt,last:documents.at(-1)?.availableAt}};
 fs.writeFileSync(path.join(dir,'recent-manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({symbols:items.length,newCandleRows:items.reduce((s,r)=>s+r.rows,0),news:manifest.news}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(async()=>{await m.$disconnect();await n.$disconnect()});
