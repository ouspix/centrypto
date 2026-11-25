import pathlib,json,hashlib,os
folder=pathlib.Path(__file__).resolve().parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
sources=['services/MarketCollectorService.ts','lib/market-observations.ts','prisma/market/schema.prisma','prisma/runtime-market/schema.prisma','collector/deploy/grants.sql','__tests__/MarketCollectorBuffer.test.ts','__tests__/MarketObservations.test.ts','scripts/market_provenance_migration.cjs','scripts/verify_market_provenance.cjs','scripts/build_market_provenance.mjs','scripts/activate_market_provenance.py','prisma/runtime-market/migrations/20261115083000_observation_provenance/migration.sql','prisma/runtime-market/migrations/20261115083500_observation_access/migration.sql','prisma/market/migrations/20261115083000_observation_provenance/migration.sql']
(folder/'source-files.json').write_text(json.dumps({'repository_root':str(folder.parent.parent),'files':{n:sha(folder.parent.parent/n) for n in sources}},indent=2))
manifest={'files':{str(p.relative_to(folder)):sha(p) for p in folder.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name!='delivery-manifest.json'},'external_cache':'/mnt/c/Users/melli/.codex/research/centrypto/policy-repair-2026-11-15','status':'implemented_and_trained_with_research_limits'}
tmp=folder/'delivery-manifest.tmp'
with tmp.open('w') as f:json.dump(manifest,f,indent=2);f.flush();os.fsync(f.fileno())
os.replace(tmp,folder/'delivery-manifest.json')
for name,digest in manifest['files'].items():
    path=folder/name;path.resolve().relative_to(folder)
    assert sha(path)==digest,name
print(json.dumps({'verified_files':len(manifest['files']),'source_files':len(sources),'hash_mismatches':0}))
