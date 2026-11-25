const fs=require('node:fs'),path=require('node:path');
const {PrismaClient:M}=require('@prisma/market-client'),{PrismaClient:N}=require('@prisma/news-client');
const m=new M({datasources:{db:{url:process.env.MARKET_DATABASE_URL}}}),n=new N({datasources:{db:{url:process.env.NEWS_DATABASE_URL}}});
const ownerAddress=process.env.NEWS_COLLECTOR_OWNER_ADDRESS?.trim().toLowerCase();if(!ownerAddress)throw Error('Missing news account scope');
async function main(){
 const out={at:new Date().toISOString()};
 out.news=await n.newsDocument.aggregate({where:{ownerAddress},_count:true,_min:{availableAt:true},_max:{availableAt:true}});
 out.candles=await m.marketCandle.findMany({where:{timeframe:'1m'},orderBy:{openTime:'desc'},take:1,select:{openTime:true}});
 out.periods=[];
 for(const [start,end] of [['2026-04-11','2026-05-01'],['2026-05-21','2026-06-10'],['2026-10-29','2026-11-14']]){
  const r=await m.marketCandle.aggregate({where:{timeframe:'1m',openTime:{gte:new Date(start),lt:new Date(end)}},_count:true,_min:{openTime:true},_max:{openTime:true}});out.periods.push({start,end,...r});
 }
 fs.writeFileSync(path.join(__dirname,'source-profile.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(async()=>{await m.$disconnect();await n.$disconnect()});
