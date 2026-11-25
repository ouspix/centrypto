const fs=require('node:fs'),path=require('node:path');
const {PrismaClient}=require('@prisma/market-client');
const db=new PrismaClient({datasources:{db:{url:process.env.MARKET_DATABASE_URL}}});
const output={queriedAt:new Date().toISOString(),readOnly:true,liquidity:[],missingExits:[],errors:[]};
const save=()=>fs.writeFileSync(path.join(__dirname,'source-db-check.json'),JSON.stringify(output,(_,v)=>typeof v==='bigint'?Number(v):v,2));
async function read(query,...args){return db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='45000ms'");return tx.$queryRawUnsafe(query,...args)},{timeout:50000});}
async function main(){
  for(const [name,start,end] of [['apr','2026-04-11','2026-05-01'],['mayjun','2026-05-21','2026-06-10'],['recent','2026-10-29','2026-11-14T08:30:00Z']]){
    try{const rows=await read('SELECT COUNT(*) AS rows,COUNT("bookBidPx") AS bid_prices,COUNT("bookBidSz") AS bid_sizes,COUNT(*) FILTER(WHERE "bookBidPx">0 AND "bookAskPx">"bookBidPx" AND "bookBidSz">0 AND "bookAskSz">0) AS valid_books,MIN(ts) FILTER(WHERE "bookBidSz">0 AND "bookAskSz">0) AS first_book FROM "MarketTick" WHERE ts >= $1::timestamp AND ts < $2::timestamp',start,end);output.liquidity.push({period:name,...rows[0]});}
    catch(e){output.errors.push({part:'liquidity',period:name,code:e.code||e.name});}save();
  }
  const cases=JSON.parse(fs.readFileSync(path.join(__dirname,'missing-exits.json'))).cases;
  const checked=new Map();
  for(const c of cases){
    const key=c.symbol+'|'+c.required_exit_time;if(checked.has(key))continue;
    try{
      const rows=await read('SELECT "openTime",open,high,low,close,volume,source FROM "MarketCandle" WHERE symbol=$1 AND timeframe=\'1m\' AND "openTime">=$2::timestamp-INTERVAL \'10 minutes\' AND "openTime"<=$2::timestamp+INTERVAL \'10 minutes\' ORDER BY "openTime"',c.symbol,c.required_exit_time);
      const exact=rows.filter(r=>+r.openTime===+new Date(c.required_exit_time));const item={symbol:c.symbol,required:c.required_exit_time,exact,neighborRows:rows};checked.set(key,item);output.missingExits.push(item);
    }catch(e){output.errors.push({part:'missing_exit',symbol:c.symbol,code:e.code||e.name});}save();
  }
  output.schema=await read("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('MarketTick','MarketCandle') ORDER BY table_name,ordinal_position");
  save();console.log(JSON.stringify({periods:output.liquidity.length,exitTimestamps:output.missingExits.length,errors:output.errors}));
}
main().catch(e=>{output.errors.push({part:'main',code:e.code||e.name});save();console.log(JSON.stringify({status:'incomplete',errors:output.errors}));process.exitCode=1}).finally(()=>db.$disconnect());
