import { describe, it, expect } from "vitest";
import { nativeInstruments, resolveDeskExposure } from "@/lib/desk/instruments";
import { buildRevision, routeRevision, legacySymbolMatch, type DeskEvidence } from "@/lib/news/desk-routing";
import type { NewsSignal, NewsFacts } from "@/types/news";

const now = new Date("2026-11-02T08:00:00Z");
const expiry = "2026-11-02T12:00:00.000Z";
const perps = [{ name: "OLD", szDecimals: 3, isDelisted: true }, { name: "kPEPE", szDecimals: 1 }, { name: "SOL", szDecimals: 3 }];
const tokens = [
    { name: "USDC", index: 0, szDecimals: 6, tokenId: "0x01" },
    { name: "MEME", index: 3, szDecimals: 2, tokenId: "0x02" },
    { name: "MEME", index: 4, szDecimals: 0, tokenId: "0x03" }
];
const spot = { tokens, universe: [{ name: "@8", index: 8, tokens: [3, 0] }, { name: "@9", index: 9, tokens: [4, 0] }] };
const instruments = nativeInstruments(false, perps, spot);
const sol = "mainnet:perp:SOL";
function doc(id: string, sourceUrl = "https://t.me/s/hyperliquid_announcements", fingerprint = id): DeskEvidence {
    return { id, canonicalUrl: sourceUrl.replace("/s/", "/") + "/10", sourceId: id, collectedAt: now, publishedAt: now, storyHash: fingerprint,
        source: { name: sourceUrl, url: sourceUrl, isPrivate: false } };
}
function signal(facts: Partial<NewsFacts> = {}): NewsSignal {
    return { eventKey: "venue-delisting", symbols: ["SOL"], category: "delisting", summary: "Venue issues delisting notice", direction: "neutral",
        confidence: 0.8, materiality: 0.9, horizon: "day_scale", claimType: "confirmed_announcement", corroboration: "Venue notice", contradictions: [], evidenceIds: ["one"], expiresAt: expiry,
        facts: { subject: { name: "SOL perp", symbol: "SOL", venue: "Hyperliquid", chain: null, contract: null }, factKey: "delisting_scheduled", change: "announcement", impact: "operational_risk", deadline: expiry,
            targets: [{ relation: "venue", symbol: "SOL", contract: null, instrumentKind: "perp", mechanism: "Venue contract settles at deadline" }],
            origins: [{ evidenceId: "one", origin: "Hyperliquid", basis: "official_notice" }], ...facts } };
}
function forBook(s: NewsSignal, held: string[] = [], end = now) {
    return routeRevision(1, buildRevision(s, [doc("one")], now, null), instruments, held, [], end);
}
describe("venue instrument identity", () => {
    it("uses exchange indices including delisted gaps and distinguishes networks and contract units", () => {
        expect(instruments[0]).toMatchObject({ asset: 1, coin: "kPEPE", base: "PEPE", multiplier: 1000 });
        expect(instruments[2]).toMatchObject({ id: "mainnet:spot:8", coin: "@8", asset: 10008, baseTokenIndex: 3, quoteTokenIndex: 0 });
        expect(nativeInstruments(true, perps, spot)[2].id).toBe("testnet:spot:8");
        expect(resolveDeskExposure(instruments, "MEME", null)).toEqual([]);
        expect(resolveDeskExposure(instruments, "MEME", "0x03").map(i => i.asset)).toEqual([10009]);
    });
});
describe("news desk replays", () => {
    it("keeps unlisted TREE unresolved and rejects a Pump.fun fee story assigned directly to SOL", () => {
        const tree = signal({ subject: { name: "Treehouse", symbol: "TREE", venue: null, chain: null, contract: null },
            targets: [{ relation: "unresolved", symbol: "TREE", contract: null, instrumentKind: "asset", mechanism: "Governance vote" }] });
        expect(forBook(tree, [sol])).toBeNull();
        expect(legacySymbolMatch({ ...tree, symbols: [], facts: undefined }, new Set(["SOL"]))).toBe(false);
        const pump = signal({ subject: { name: "Pump.fun", symbol: "PUMP", venue: null, chain: "Solana", contract: null },
            impact: "catalyst", targets: [{ relation: "direct", symbol: "SOL", contract: null, instrumentKind: "asset", mechanism: "Runs on Solana" }] });
        expect(forBook(pump)).toBeNull();
        expect(legacySymbolMatch(pump, new Set(["SOL"]))).toBe(false);
        pump.facts!.targets[0].relation = "indirect";
        pump.facts!.targets[0].channel = "none";
        expect(forBook(pump)).toBeNull();
    });
    it("routes a confirmed venue delisting only to exposed books, even on late recovery", () => {
        expect(forBook(signal(), [])).toBeNull();
        expect(forBook(signal(), [sol], new Date("2026-11-04"))).toMatchObject({ verified: true, kind: "risk", instrumentIds: [sol] });
        const catalyst = signal({ impact: "catalyst" });
        expect(forBook(catalyst)).toMatchObject({ kind: "discovery", instrumentIds: [sol] });
        expect(forBook(catalyst, [], new Date("2026-11-04"))).toBeNull();
    });
    it("exposes an outbound research subject only when public original evidence contains it", () => {
        const pub = { ...doc("one"), text: "SOL perp settles at the scheduled vote." };
        const enriched = buildRevision(signal(), [pub], now, null);
        expect(enriched.publicSubject).toBe("SOL perp");
        expect(routeRevision(1,enriched,instruments,[sol],[],now)?.publicSubject).toBe("SOL perp");
        expect(buildRevision(signal(), [{...pub,text:"Anonymous announcement"}],now,null).publicSubject).toBeUndefined();
        expect(buildRevision(signal(), [pub,{...doc("unrelated"),source:{...pub.source,isPrivate:true}}],now,null).publicSubject).toBeUndefined();
    });
    it("distinguishes syndication from independent first-hand reports; contradictions block verification", () => {
        const documents = [doc("one", "https://t.me/s/coinnesskr"), doc("two", "https://t.me/s/foresightnews")];
        const s = signal({ origins: [{ evidenceId: "one", origin: "Coinness", basis: "independent_reporting" },
            { evidenceId: "two", origin: "Coinness", basis: "relay" }] });
        s.evidenceIds = ["one","two"];
        expect(buildRevision(s, documents, now, null).verified).toBe(false);
        s.facts!.origins[1] = { evidenceId: "two", origin: "Foresight News", basis: "independent_reporting" };
        expect(buildRevision(s, documents, now, null).verified).toBe(true);
        expect(buildRevision(s, [documents[0], { ...documents[1], storyHash: "one" }], now, null).verified).toBe(false);
        expect(buildRevision(s, [documents[0], { ...documents[1], canonicalUrl: "https://t.me/copycat/10" }], now, null).verified).toBe(false);
        s.contradictions.push("Venue disputes the date");
        expect(buildRevision(s, documents, now, null).verified).toBe(false);
    });
    it("wakes once per material change and revisits a followed thesis on retraction", () => {
        const first = buildRevision(signal(), [doc("one")], now, null);
        const prior = { id: 4, details: first };
        const repeat = signal({ change: "repeat", factKey: "synonym_in_copy" });
        repeat.expiresAt = "2026-11-03T08:00:00Z";
        const second = buildRevision(repeat, [doc("one")], new Date(now.getTime()+60000), prior);
        expect(second.signal.expiresAt).toBe(expiry);
        expect(second.material).toBe(false);
        const mislabeledRepost = buildRevision(signal({factKey: "same_text_paraphrased", change: "update"}), [doc("one")], now, prior);
        expect(mislabeledRepost.material).toBe(false);
        expect(routeRevision(5, second, instruments, [sol], [], new Date("2026-11-03"))).toBeNull();
        const retracted = signal({ change: "retraction", factKey: "vote_cancelled", targets: [] });
        const third = buildRevision(retracted, [doc("one")], now, prior);
        expect(routeRevision(6, third, instruments, [], [retracted.eventKey], now)).toMatchObject({ revisionId: 6, kind: "correction" });
    });
});
