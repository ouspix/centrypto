// @vitest-environment node
import {beforeEach,describe,it,expect,vi} from "vitest";
import type {NewsSignal,NewsContext} from "@/types/news";
import type {DeskInstrument} from "@/lib/desk/instruments";
const mock=vi.hoisted(()=>({briefing:vi.fn(),evidence:vi.fn()}));
vi.mock("@/services/NewsIntelligenceService",()=>({NewsIntelligenceService:vi.fn(()=>mock)}));
vi.mock("@/lib/news/account",()=>({newsAccountAddress:()=>"configured-news-account"}));
import {deskNewsSentiment} from "@/lib/desk/news-sentiment";
const now=new Date("2026-11-06T08:00:00Z");
const btc={id:"mainnet:perp:BTC",coin:"BTC",base:"BTC",quote:"USDC",kind:"perp",isTestnet:false,tokenId:null,evmContract:null} as DeskInstrument;
const signal=():NewsSignal=>({eventKey:"event",symbols:["BTC"],category:"market_structure",summary:"Observed supply change",direction:"bullish",confidence:.8,materiality:.7,horizon:"day_scale",claimType:"reported_claim",
    corroboration:"One origin",contradictions:["No execution evidence"],evidenceIds:["doc"],expiresAt:"2026-11-06T12:00:00Z",facts:{
        subject:{name:"Bitcoin",symbol:"BTC",chain:null,contract:null,venue:null},targets:[{relation:"direct",symbol:"BTC",contract:null,instrumentKind:"asset",channel:"supply",mechanism:"Supply changed"}],
        factKey:"fact",change:"announcement",impact:"catalyst",deadline:null,origins:[{evidenceId:"doc",origin:"Publisher",basis:"independent_reporting"}]}});
const context=():NewsContext=>({status:"incomplete",briefingId:"brief",availableAt:"2026-11-06T07:55:00Z",asOf:now.toISOString(),summary:"Recent analysis",signals:[signal()],coverage:{configured:3,healthy:2,pendingDocuments:1,rejectedDocuments:0,gaps:["One source unavailable"]}});
beforeEach(()=>{vi.clearAllMocks();mock.briefing.mockResolvedValue(context());mock.evidence.mockResolvedValue([{id:"doc",source:{name:"Publisher",isPrivate:true},publishedAt:new Date("2026-11-06T07:40:00Z"),collectedAt:new Date("2026-11-06T07:42:00Z"),canonicalUrl:"https://private.example/item",completeness:"complete"}]);});
describe("desk sentiment from News Intelligence",()=>{
    it("uses the configured collector namespace and preserves evidence quality, dates and gaps",async()=>{
        const result=await deskNewsSentiment(btc,[btc],now);
        expect(mock.briefing).toHaveBeenCalledWith("configured-news-account",["BTC"],now,true);
        expect(mock.evidence).toHaveBeenCalledWith("configured-news-account",["doc"]);
        expect(result).toMatchObject({source:"news_intelligence",status:"observed",directionalEvidence:{bullish:1},coverage:{healthy:2,pendingDocuments:1},signals:[{confidence:.8,contradictions:["No execution evidence"]}]});
        expect(result.evidence[0].publishedAt).toEqual(new Date("2026-11-06T07:40:00Z"));expect(result.evidence[0]).not.toHaveProperty("url");
    });
    it("does not manufacture neutral sentiment when there are no applicable signals",async()=>{
        mock.briefing.mockResolvedValue({...context(),signals:[]});
        expect(await deskNewsSentiment(btc,[btc],now)).toMatchObject({status:"no_relevant_signals",directionalEvidence:null,signals:[]});
        expect(mock.evidence).not.toHaveBeenCalled();
    });
    it("excludes expired events, ambiguous tickers and unsupported causal links",async()=>{
        const expired={...signal(),expiresAt:"2026-11-06T07:00:00Z"};
        const unrelated=signal();unrelated.facts!.targets[0].relation="indirect";unrelated.facts!.targets[0].channel="none";
        mock.briefing.mockResolvedValue({...context(),signals:[expired,unrelated]});
        expect((await deskNewsSentiment(btc,[btc],now)).signals).toEqual([]);
        const spot={...btc,id:"mainnet:spot:1",kind:"spot",tokenId:"first"} as DeskInstrument;
        mock.briefing.mockResolvedValue(context());
        expect((await deskNewsSentiment(spot,[spot,{...spot,id:"mainnet:spot:2",tokenId:"other"}],now)).signals).toEqual([]);
    });
    it("keeps stale analysis and missing evidence explicit",async()=>{
        mock.briefing.mockResolvedValue({...context(),availableAt:"2026-11-05T08:00:00Z"});
        expect((await deskNewsSentiment(btc,[btc],now)).status).toBe("stale");
        mock.briefing.mockResolvedValue(context());mock.evidence.mockResolvedValue([]);
        expect(await deskNewsSentiment(btc,[btc],now)).toMatchObject({status:"no_relevant_signals",signals:[],coverage:{excludedMissingEvidence:1}});
    });
});
