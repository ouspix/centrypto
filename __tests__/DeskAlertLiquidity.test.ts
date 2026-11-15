// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESK_MANDATE } from "@/lib/desk/mandate";
const f=vi.hoisted(()=>({cache:null as any,exposure:vi.fn(),quote:vi.fn(),intents:[] as any[]}));
vi.mock("@/lib/db",()=>({prisma:{deskIntent:{findMany:async()=>f.intents},deskRecord:{findUnique:async()=>f.cache,upsert:async(a:any)=>{f.cache={dataJson:a.update.dataJson};}}}}));
vi.mock("@/lib/desk/news-exposure",()=>({newsExposure:f.exposure}));
vi.mock("@/lib/desk/market",()=>({instrument:async()=>({quoteTokenIndex:0}),publicQuote:f.quote}));
import {filterMarketAlerts,liquidAlert} from "@/lib/desk/alert-liquidity";
const book={id:"b",isTestnet:false,mandateJson:JSON.stringify(DEFAULT_DESK_MANDATE)} as any;
const move=(instrumentId="mainnet:spot:123")=>({instrumentId,mid:100,previous:90,move:0.111});
const quote=(size:string)=>({bid:99.99,ask:100.01,bids:[{px:"99.99",sz:size}],asks:[{px:"100.01",sz:size}]});
beforeEach(()=>{f.cache=null;f.intents=[];vi.clearAllMocks();f.exposure.mockResolvedValue({heldIds:[],coverage:{needsReconciliation:false}});f.quote.mockResolvedValue(quote("0.01"));});
describe("market alert admission",()=>{
 it("suppresses unheld thin spot movers and reuses their cooldown without another quote",async()=>{
   const now=new Date();const first=await filterMarketAlerts(book,[move()],now);
   expect(first.moves).toEqual([]);expect(first.suppressed[0].reason).toContain("executable_depth");
   await filterMarketAlerts(book,[move()],new Date(+now+300000));expect(f.quote).toHaveBeenCalledTimes(1);
   await filterMarketAlerts(book,[move()],new Date(+now+31*60000));expect(f.quote).toHaveBeenCalledTimes(2);
 });
 it("preserves held, unresolved and unknown-exposure alerts",async()=>{
   f.exposure.mockResolvedValueOnce({heldIds:[move().instrumentId],coverage:{needsReconciliation:false}});
   expect((await filterMarketAlerts(book,[move()],new Date())).moves).toHaveLength(1);
   f.intents=[{instrumentId:move().instrumentId}];
   expect((await filterMarketAlerts(book,[move()],new Date())).moves).toHaveLength(1);
   f.intents=[];f.exposure.mockResolvedValueOnce({heldIds:[],coverage:{needsReconciliation:true}});
   expect((await filterMarketAlerts(book,[move()],new Date())).moves).toHaveLength(1);
   expect(f.quote).not.toHaveBeenCalled();
 });
 it("requires exit depth as well as entry depth and bounds quote work",async()=>{
   expect(liquidAlert({...quote("100"),bids:[{px:"99.99",sz:"0.01"}]},25,100).eligible).toBe(false);
   const result=await filterMarketAlerts(book,Array.from({length:10},(_,i)=>move("mainnet:spot:"+i)),new Date());
   expect(f.quote).toHaveBeenCalledTimes(6);expect(result.suppressed).toHaveLength(10);
   f.quote.mockResolvedValue(quote("100"));f.cache=null;
   expect((await filterMarketAlerts(book,[move(),move("mainnet:perp:SOL")],new Date())).moves.map(m=>m.instrumentId)).toEqual(["mainnet:perp:SOL","mainnet:spot:123"]);
 });
});
