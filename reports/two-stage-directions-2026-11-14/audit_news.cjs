// Read-only, account-scoped profile. Never export article text or credentials.
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/news-client');
const db = new PrismaClient({ datasources: { db: { url: process.env.NEWS_DATABASE_URL } } });
const ownerAddress = process.env.NEWS_COLLECTOR_OWNER_ADDRESS?.trim().toLowerCase();
if (!ownerAddress) throw new Error('Missing news account scope');
const countBy = (rows, key) => rows.reduce((out, row) => { const v = key(row) ?? '(missing)'; out[v] = (out[v] || 0) + 1; return out; }, {});
const range = values => {
  const v = values.filter(Number.isFinite).sort((a,b) => a-b);
  return {observed:v.length, min:v[0]??null, median:v[Math.floor(v.length/2)]??null, max:v.at(-1)??null};
};
function signalProfile(rows) {
  const signals = rows.flatMap(a => JSON.parse(a.resultJson).signals || []);
  const targets = signals.flatMap(s => s.facts?.targets || []);
  const explicit = s => (s.facts?.targets || []).filter(t => ['direct','indirect'].includes(t.relation) && t.symbol && t.mechanism?.trim() && t.channel !== 'none');
  return {
    analyses: rows.length, signal_revisions: signals.length, unique_event_keys: new Set(signals.map(s=>s.eventKey)).size,
    direction:countBy(signals,s=>s.direction), claim_type:countBy(signals,s=>s.claimType), horizon:countBy(signals,s=>s.horizon),
    confidence:range(signals.map(s=>s.confidence)), materiality:range(signals.map(s=>s.materiality)),
    category_distinct:new Set(signals.map(s=>s.category)).size,
    category_top:Object.fromEntries(Object.entries(countBy(signals,s=>s.category)).sort((a,b)=>b[1]-a[1]).slice(0,20)),
    with_facts:signals.filter(s=>s.facts).length, with_explicit_direct_or_indirect_asset_targets:signals.filter(s=>explicit(s).length).length,
    with_multiple_symbols:signals.filter(s=>(s.symbols||[]).length>1).length,
    with_multiple_explicit_asset_targets:signals.filter(s=>new Set(explicit(s).map(t=>t.symbol)).size>1).length,
    with_contradictions:signals.filter(s=>s.contradictions?.length).length,
    target_relation:countBy(targets,t=>t.relation), target_channel:countBy(targets,t=>t.channel), target_instrument_kind:countBy(targets,t=>t.instrumentKind),
    fact_change:countBy(signals.filter(s=>s.facts),s=>s.facts.change), fact_impact:countBy(signals.filter(s=>s.facts),s=>s.facts.impact),
    legacy_symbol_links:(signals.flatMap(s=>s.symbols||[])).length,
    legacy_symbol_links_without_explicit_asset_target:signals.reduce((n,s)=>n+(s.symbols||[]).filter(sym=>!explicit(s).some(t=>t.symbol===sym)).length,0),
    signal_fields:[...new Set(signals.flatMap(s=>Object.keys(s)))].sort(),
    fact_fields:[...new Set(signals.flatMap(s=>Object.keys(s.facts||{})))].sort(),
    target_fields:[...new Set(targets.flatMap(t=>Object.keys(t)))].sort()
  };
}
async function main() {
  const at=new Date(), todayStart=new Date('2026-11-13T23:00:00Z');
  const where={ownerAddress,availableAt:{lte:at}};
  const [documents,analyses,revisions]=await Promise.all([
    db.newsDocument.findMany({where,select:{id:true,storyHash:true,publishedAt:true,collectedAt:true,availableAt:true,status:true},orderBy:{availableAt:'asc'}}),
    db.newsAnalysis.findMany({where,select:{id:true,availableAt:true,resultJson:true},orderBy:{availableAt:'asc'}}),
    db.newsEventRevision.findMany({where,select:{eventKey:true,analysisId:true,availableAt:true,detailsJson:true},orderBy:{availableAt:'asc'}})
  ]);
  const docIds=new Set(documents.map(d=>d.id)), allSignals=analyses.flatMap(a=>JSON.parse(a.resultJson).signals||[]);
  const today=documents.filter(d=>d.availableAt>=todayStart);
  const recentAnalyses=analyses.filter(a=>a.availableAt>=todayStart);
  const latest=new Map();
  for(const a of analyses) for(const signal of JSON.parse(a.resultJson).signals||[]) latest.set(signal.eventKey,{at:a.availableAt,signal});
  for(const r of revisions) { const signal=JSON.parse(r.detailsJson).signal; if(signal && (!latest.has(r.eventKey)||latest.get(r.eventKey).at<=r.availableAt)) latest.set(r.eventKey,{at:r.availableAt,signal}); }
  const active=[...latest.values()].filter(e=>Date.parse(e.signal.expiresAt)>+at && e.signal.evidenceIds?.length && e.signal.evidenceIds.every(id=>docIds.has(id))).map(e=>e.signal);
  const result={as_of:at.toISOString(),today_start_paris:todayStart.toISOString(),read_only:true,
    documents:{total:documents.length,unique_story_hashes:new Set(documents.map(d=>d.storyHash)).size,first_available:documents[0]?.availableAt,last_available:documents.at(-1)?.availableAt,today_ingested:today.length,today_status:countBy(today,d=>d.status)},
    all:signalProfile(analyses),today:signalProfile(recentAnalyses),immutable_revision_rows:revisions.length,
    missing_evidence_signal_revisions:allSignals.filter(s=>!s.evidenceIds?.length||s.evidenceIds.some(id=>!docIds.has(id))).length,
    latest_active_events:active.length,latest_active_directions:countBy(active,s=>s.direction),
    latest_active_asset_links:active.flatMap(s=>(s.facts?.targets||[]).filter(t=>['direct','indirect'].includes(t.relation)&&t.symbol&&t.mechanism?.trim()&&t.channel!=='none')).length,
    note:'Signal counts are immutable analysis appearances, not independent stories or trades. Today is ingestion/analysis availability on 14 Nov in Europe/Paris. No raw article text exported.'};
  fs.writeFileSync(path.join(__dirname,'news-audit.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('News audit failed; no credentials or raw error payload logged.');process.exitCode=1;}).finally(()=>db.$disconnect());
