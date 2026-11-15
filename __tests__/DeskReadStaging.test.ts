// @vitest-environment node
import {describe,it,expect,vi} from "vitest";
const post=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/rate-limit/hyperliquid-limiter",()=>({hyperliquidInfoPost:post}));
import {listInstruments} from "@/lib/desk/instruments";
import {ResearchReadQueue} from "@/lib/desk/read-queue";
describe("deferred analytical reads",()=>{
    it("resolves native perpetuals without touching unavailable spot metadata",async()=>{
        post.mockImplementation(async(_bucket,_url,body)=>{
            if(body.type==="meta")return {universe:[{name:"BTC",szDecimals:5}]};
            throw new Error("spot metadata unavailable");
        });
        expect((await listInstruments(false,"perp")).map(i=>i.id)).toEqual(["mainnet:perp:BTC"]);
        expect(post.mock.calls.map(c=>c[2].type)).toEqual(["meta"]);
        await expect(listInstruments(false)).rejects.toThrow("spot metadata unavailable");
    });
    it("serializes research downloads, survives failure and skips cancelled work",async()=>{
        const queue=new ResearchReadQueue(0),order:string[]=[];
        let release!:()=>void;
        const held=new Promise<void>(r=>{release=r;});
        const first=queue.run(async()=>{order.push("first");await held;throw Error("offline");});
        const caught=first.catch(e=>e.message);
        const stop=new AbortController();
        const cancelled=queue.run(async()=>{order.push("cancelled");},stop.signal).catch(()=>"cancelled");
        const second=queue.run(async()=>{order.push("second");return 2;});
        await Promise.resolve();await Promise.resolve();
        expect(order).toEqual(["first"]);
        stop.abort();release();
        expect(await caught).toBe("offline");expect(await cancelled).toBe("cancelled");
        expect(await second).toBe(2);expect(order).toEqual(["first","second"]);
    });
});
