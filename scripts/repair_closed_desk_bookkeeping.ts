import Module from "node:module";
import fs from "node:fs/promises";
const loader=Module as any, original=loader._load;
loader._load=function(name:string,...args:any[]){return name==="server-only"?{}:original.call(this,name,...args);};
async function main(){
    const [{prisma},{DeskExecution},{hyperliquidDeskVenue},{portfolioContext},{verifiedFlatBook}]=await Promise.all([
        import("../lib/db"),import("../lib/desk/execution"),import("../lib/desk/venue"),import("../lib/desk/portfolio-context"),import("../lib/desk/review-schedule")]);
    try {
        const ownerAddress=process.env.NEWS_COLLECTOR_OWNER_ADDRESS?.trim().toLowerCase();
        if(!ownerAddress)throw new Error("Configured account scope required");
        const book=await prisma.deskBook.findFirstOrThrow({where:{ownerAddress,isTestnet:false,kind:"directional"}});
        const snapshot=async()=>({
            inventory:await prisma.deskInventory.findMany({where:{bookId:book.id,instrumentId:"mainnet:perp:ETH"}}),
            intents:await prisma.deskIntent.findMany({where:{bookId:book.id,instrumentId:"mainnet:perp:ETH"},
                select:{id:true,state:true,filledQty:true,quantity:true,reservedUsd:true,reason:true,updatedAt:true}}),
            portfolio:await portfolioContext(prisma,book),verifiedFlat:await verifiedFlatBook(prisma,book),
        });
        const before=await snapshot();
        if(process.argv.includes("--apply")){
            const engine=new DeskExecution(prisma,{...hyperliquidDeskVenue,write:async()=>{throw new Error("Exchange writes disabled in bookkeeping repair");}});
            await engine.reconcile(book.id);
        }
        const after=await snapshot();
        const report={at:new Date().toISOString(),applied:process.argv.includes("--apply"),bookId:book.id,before,after,
            reconciliations:await prisma.deskRecord.findMany({where:{bookId:book.id,kind:"inventory_reconciliation"},select:{id:true,dataJson:true,createdAt:true}})};
        await fs.writeFile("reports/desk-closed-bookkeeping-repair-2026-11-15.json",JSON.stringify(report,null,2));
        console.log(JSON.stringify(report));
    }finally{await prisma.$disconnect();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
