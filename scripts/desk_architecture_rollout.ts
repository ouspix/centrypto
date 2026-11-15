import Module from "node:module";
import fs from "node:fs/promises";
const loader=Module as any,original=loader._load;
loader._load=function(request:string,...args:any[]){return request==="server-only"?{}:original.call(this,request,...args);};
async function main(){
 const [{prisma},{getHyperliquidApiWalletStatus}]=await Promise.all([import("../lib/db"),import("../lib/hyperliquid-api-wallet")]);
 try{
  const books=await prisma.deskBook.findMany(),owners=[...new Set(books.map(b=>b.ownerAddress))];
  if(owners.length!==1)throw new Error("Expected one installed desk owner for this rollout.");
  const owner=owners[0],args=process.argv.slice(2);
  if(args.includes("--pause")){
   const state={asOf:new Date().toISOString(),books:books.map(b=>({id:b.id,enabled:b.enabled,version:b.version,isTestnet:b.isTestnet}))};
   await fs.mkdir("data/deployment",{recursive:true});
   await fs.writeFile("data/deployment/desk-rebuild-state.json",JSON.stringify(state,null,2),{flag:"wx"});
   await prisma.deskBook.updateMany({where:{enabled:true},data:{enabled:false,version:{increment:1}}});
  }
  if(args.includes("--restore")){
   const {updateBook}=await import("../lib/desk/books");
   const state=JSON.parse(await fs.readFile("data/deployment/desk-rebuild-state.json","utf8"));
   for(const prior of state.books)if(prior.enabled){
    const b=await prisma.deskBook.findUniqueOrThrow({where:{id:prior.id}});
    if(!b.enabled)await updateBook(b,{version:b.version,enabled:true});
   }
  }
  let activation:unknown=null;
  if(args.includes("--activate-paper")){
   const {addBook,updateBook}=await import("../lib/desk/books");
   let paper=await prisma.deskBook.findFirst({where:{ownerAddress:owner,isTestnet:true,kind:"directional"}});
   const basis=books.find(b=>b.kind==="directional")!;
   if(!paper)paper=await addBook(owner,{accountAddress:owner,isTestnet:true,kind:"directional",mandate:JSON.parse(basis.mandateJson)});
   const status=await getHyperliquidApiWalletStatus(owner,true);
   if(status.configured){
    if(!paper.enabled)paper=await updateBook(paper,{version:paper.version,enabled:true});
    activation={status:"active",bookId:paper.id,network:"testnet"};
   }else activation={status:"needs_testnet_delegation",bookId:paper.id,network:"testnet"};
  }
  const current=await prisma.deskBook.findMany();
  const credentials=await Promise.all([false,true].map(async testnet=>({network:testnet?"testnet":"mainnet",configured:(await getHyperliquidApiWalletStatus(owner,testnet)).configured})));
  const intents=await prisma.deskIntent.groupBy({by:["state"],_count:true});
  const inventory=await prisma.deskInventory.count({where:{quantity:{not:0}}});
  const report={asOf:new Date().toISOString(),activation,books:current.map(b=>({id:b.id,isTestnet:b.isTestnet,enabled:b.enabled,version:b.version,heartbeatAt:b.heartbeatAt,lastError:b.lastError})),credentials,intents,inventory};
  await fs.writeFile("reports/desk-rebuild-runtime-2026-11-06.json",JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
 }finally{await prisma.$disconnect();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

