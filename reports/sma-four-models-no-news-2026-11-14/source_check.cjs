// Public read-only endpoint checks of the three largest replay winners.
const fs=require('node:fs'),path=require('node:path');
const text=fs.readFileSync(path.join(__dirname,'predictions.csv'),'utf8').trim().split(/\r?\n/);
const header=text.shift().split(','),rows=text.map(line=>Object.fromEntries(line.split(',').map((v,i)=>[header[i],v]))).sort((a,b)=>+b.return_pct-+a.return_pct).slice(0,3);
async function main(){
  const checks=[];
  for(const trade of rows){
    const at=[Date.parse(trade.entry_time),Date.parse(trade.exit_time)];const prices=[];
    for(const t of at){
      const res=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin:trade.symbol,interval:'1m',startTime:t,endTime:t+60000}}),signal:AbortSignal.timeout(15000)});
      if(!res.ok){prices.push({time:t,status:res.status});continue;}
      const body=await res.json();const match=Array.isArray(body)?body.find(c=>c.t===t):null;
      prices.push({time:t,available:!!match,open:match?+match.o:null,close:match?+match.c:null,volume:match?+match.v:null});
    }
    const actual=prices.every(p=>p.available)?+trade.side_sign*100*(prices[1].open/prices[0].open-1):null;
    checks.push({symbol:trade.symbol,side:trade.side,entry:trade.entry_time,exit:trade.exit_time,recorded_return_pct:+trade.return_pct,exchange_return_pct:actual,
      difference:actual===null?null:actual-(+trade.return_pct),prices});
  }
  fs.writeFileSync(path.join(__dirname,'public-source-check.json'),JSON.stringify({checked_at:new Date().toISOString(),endpoint:'https://api.hyperliquid.xyz/info',checks},null,2));
  console.log(JSON.stringify(checks.map(c=>({symbol:c.symbol,recorded:c.recorded_return_pct,exchange:c.exchange_return_pct,difference:c.difference}))));
}
main().catch(e=>{console.error('Public read unavailable: '+e.name);process.exitCode=1;});
