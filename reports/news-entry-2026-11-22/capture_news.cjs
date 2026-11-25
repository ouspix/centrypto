// Snapshot only fields needed for the offline, account-scoped experiment.
const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/news-client');

const root = path.resolve(__dirname, '../..');
const dest = path.join(root, 'data/research/centrypto', path.basename(__dirname));
const cutoff = new Date('2026-11-20T12:00:00Z');
const env = dotenv.parse(fs.readFileSync(path.join(root, '.env.local')));
const ownerAddress = env.NEWS_COLLECTOR_OWNER_ADDRESS?.trim().toLowerCase();
const db = new PrismaClient({ datasources: { db: { url: env.NEWS_DATABASE_URL } }, log: [] });
const digest = data => createHash('sha256').update(data).digest('hex');

function signal(s) {
    const { eventKey, symbols, category, direction, confidence, materiality, horizon,
        claimType, evidenceIds, expiresAt, eventAvailableAt, facts } = s;
    return { eventKey, symbols, category, direction, confidence, materiality, horizon,
        claimType, evidenceIds, expiresAt, eventAvailableAt,
        contradicted: Boolean(s.contradictions?.length),
        facts: facts && { factKey: facts.factKey, change: facts.change, impact: facts.impact,
            targets: facts.targets.map(t => ({
                relation: t.relation, symbol: t.symbol, contract: t.contract,
                instrumentKind: t.instrumentKind, channel: t.channel,
            })),
            origins: facts.origins.map(o => ({ evidenceId: o.evidenceId, basis: o.basis })),
        },
    };
}

async function main() {
    if (!ownerAddress || !env.NEWS_DATABASE_URL) throw Error('Missing news account configuration');
    const snapshotPath = path.join(dest, 'news-snapshot.json.gz');
    const manifestPath = path.join(dest, 'news-source.json');
    if (fs.existsSync(snapshotPath) && fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.cutoff === cutoff.toISOString() && manifest.sha256 === digest(fs.readFileSync(snapshotPath))
            && manifest.exporter_sha256 === digest(fs.readFileSync(__filename))) {
            console.log(JSON.stringify(manifest));
            return;
        }
        throw Error('Existing snapshot differs from the input lock');
    }
    const where = { ownerAddress, availableAt: { lt: cutoff } };
    const byTime = [{ availableAt: 'asc' }, { id: 'asc' }];
    const snapshot = await db.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const documents = await tx.newsDocument.findMany({ where, orderBy: byTime, select: {
            id: true, storyHash: true, publishedAt: true, collectedAt: true, availableAt: true,
        } });
        const analyses = await tx.newsAnalysis.findMany({ where, orderBy: byTime, select: {
            id: true, availableAt: true, resultJson: true,
        } });
        const revisions = await tx.newsEventRevision.findMany({ where, orderBy: byTime, select: {
            id: true, analysisId: true, eventKey: true, material: true, availableAt: true, detailsJson: true,
        } });
        return {
            documents,
            analyses: analyses.map(({ resultJson, ...row }) => ({
                ...row, signals: (JSON.parse(resultJson).signals || []).map(signal),
            })),
            revisions: revisions.map(({ detailsJson, ...row }) => ({
                ...row, signal: signal(JSON.parse(detailsJson).signal),
            })),
        };
    }, { isolationLevel: 'RepeatableRead', timeout: 60000 });
    const compressed = gzipSync(JSON.stringify(snapshot));
    const manifest = { cutoff: cutoff.toISOString(), sha256: digest(compressed),
        exporter_sha256: digest(fs.readFileSync(__filename)),
        counts: Object.fromEntries(Object.entries(snapshot).map(([key, rows]) => [key, rows.length])),
        first_document: snapshot.documents[0]?.availableAt, last_document: snapshot.documents.at(-1)?.availableAt };
    if (!manifest.first_document || !manifest.last_document) throw Error('Empty news snapshot');
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const [target, value] of [[snapshotPath, compressed], [manifestPath, JSON.stringify(manifest, null, 2)]]) {
        const tmp = target + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, value, { mode: 0o600 });
        fs.renameSync(tmp, target);
    }
    console.log(JSON.stringify(manifest));
}

main().catch(e => {
    console.error('News snapshot failed: ' + (e.code || e.name));
    process.exitCode = 1;
}).finally(() => db.$disconnect());
