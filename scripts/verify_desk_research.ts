import Module from "node:module";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
const loader=Module as any,original=loader._load;
loader._load=function(request:string,...args:any[]){return request==="server-only"?{}:original.call(this,request,...args);};
async function main(){
 const [{prisma},{enqueueResearch,researchStatus},{operatorMessage},{createWalletSessionToken,WALLET_SESSION_COOKIE}]=await Promise.all([
  import("../lib/db"),import("../lib/desk/backtest/jobs"),import("../lib/desk/books"),import("../lib/auth/wallet-session")]);
 try{
  const reportFile="reports/desk-research-smoke-2026-11-06.json";
  if(process.argv.includes("--status")){
   const prior=JSON.parse(await fs.readFile(reportFile,"utf8"));
   const states=[];
   for(const r of prior.runs){const x=await researchStatus(prisma,r.bookId,r.runId);
    states.push({bookId:r.bookId,runId:x.runId,status:x.status,error:x.error,network:x.network,resultArtifactId:x.resultArtifactId,
      result:x.result?{scope:(x.result as any).scope,coverage:(x.result as any).coverage,selectedVariant:(x.result as any).selectedVariant,
        variants:(x.result as any).variants?.map((v:any)=>({name:v.name,validation:v.validation.metrics,limitations:v.validation.limitations})),
        holdout:(x.result as any).holdout?.metrics}:null});}
   const tools=await prisma.deskRecord.findMany({where:{bookId:prior.paperBookId,kind:"tool_result",createdAt:{gte:new Date(prior.startedAt)}},orderBy:{id:"desc"},take:40,select:{role:true,dataJson:true}});
   const updated={...prior,asOf:new Date().toISOString(),states,agentTools:tools.map(r=>({role:r.role,...JSON.parse(r.dataJson)})).map(({role,name,artifactId,error})=>({role,name,artifactId,error}))};
   await fs.writeFile(reportFile,JSON.stringify(updated,null,2));console.log(JSON.stringify(updated));return;
  }
  const books=await prisma.deskBook.findMany({where:{kind:"directional"}}),main=books.find(b=>!b.isTestnet)!,paper=books.find(b=>b.isTestnet)!;
  const end=new Date(Math.floor(Date.now()/60000)*60000-60000),start=new Date(+end-3*3600000);
  const make=(testnet:boolean)=>({hypothesis:"Bounded BTC momentum continuation after a 12-minute move, with stops, fixed size and explicit costs.",
    source:testnet?"collector":"archive",start:testnet?start.toISOString():"2026-04-13T12:00:00Z",end:testnet?end.toISOString():"2026-04-13T15:00:00Z",instrumentIds:[(testnet?"testnet":"mainnet")+":perp:BTC"],
    intervalSeconds:60,feeBpsPerSide:3.5,extraSlippageBps:1,variants:[{name:"BTC momentum",signal:"momentum",side:"both",lookbackBars:12,thresholdBps:5,
      orderUsd:25,stopBps:50,targetBps:100,maxHoldBars:30,cooldownBars:5}]});
  const session=createWalletSessionToken(main.ownerAddress),cookie=WALLET_SESSION_COOKIE+"="+encodeURIComponent(session.sessionToken);
  const res=await fetch("http://localhost:3000/api/backtest/run",{method:"POST",headers:{"Content-Type":"application/json",cookie,origin:"http://localhost:3000"},body:JSON.stringify({bookId:main.id,request:make(false)})});
  const first=await res.json();if(res.status!==202)throw new Error("Authenticated research API failed: "+JSON.stringify(first));
  const second=await enqueueResearch(prisma,paper,make(true));
  const message=await operatorMessage(paper,{kind:"research",requestId:randomUUID(),
    message:"Verify the new desk research tools in read-only mode. Call backtest_catalog and backtest_status for run "+second.runId+". If it is pending, record the run ID and wait for the completion review rather than polling in a loop. Explain coverage, costs, risk rejections and holdout limitations in the lead note. Also use backtest_strategy once to queue a small BTC hypothesis of your choice from the available collector history, with explicit costs and fixed risk limits. This is an integration check: incomplete history is expected while the new quote collector warms up, so describe the limitations and do not interpret it as validated trading performance. Inspect its result on completion. The operator explicitly asked to leave the paper book stopped. Do not activate it or place orders."});
  const report={startedAt:new Date().toISOString(),apiStatus:res.status,paperBookId:paper.id,researchWakeId:message.id,
    runs:[{bookId:main.id,runId:first.runId},{bookId:paper.id,runId:second.runId}]};
  await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await prisma.$disconnect();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

