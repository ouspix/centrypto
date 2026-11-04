// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { appDatabaseUrl, ensureAppDbReady } from '@/lib/db';

describe('application database concurrency', () => {
    it('preserves explicit connection settings and other database URLs', () => {
        expect(appDatabaseUrl('file:./backend.db?socket_timeout=1')).toBe('file:./backend.db?socket_timeout=1&connection_limit=1');
        expect(appDatabaseUrl('file:./backend.db?connection_limit=2&socket_timeout=3')).toBe('file:./backend.db?connection_limit=2&socket_timeout=3');
        expect(appDatabaseUrl('postgresql://localhost/app?connection_limit=2')).toBe('postgresql://localhost/app?connection_limit=2');
    });

    it('queues concurrent writes without exhausting SQLite busy timeouts', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'centrypto-write-queue-'));
        const url = appDatabaseUrl(`file:${path.join(directory, 'app.db')}?socket_timeout=1`);
        const client = new PrismaClient({ datasources: { db: { url } } });
        try {
            await ensureAppDbReady(client);
            await client.$executeRawUnsafe('CREATE TABLE Counter (id INTEGER PRIMARY KEY, value INTEGER)');
            await client.$executeRawUnsafe('INSERT INTO Counter VALUES (1, 0)');
            // With the default multi-connection pool, waiting writers time out
            // while another connection holds this same process's transaction.
            const writes = await Promise.allSettled(Array.from({ length: 40 }, () => client.$transaction(async tx => {
                await tx.$queryRawUnsafe('SELECT value FROM Counter');
                await new Promise(resolve => setTimeout(resolve, 40));
                await tx.$executeRawUnsafe('UPDATE Counter SET value = value + 1 WHERE id = 1');
            }, { maxWait: 10000, timeout: 5000 })));
            expect(writes.filter(result => result.status === 'rejected')).toEqual([]);
            expect(await client.$queryRawUnsafe('SELECT value FROM Counter')).toEqual([{ value: 40 }]);
        } finally {
            await client.$disconnect();
            await rm(directory, { recursive: true, force: true });
        }
    }, 15000);

    it('saves a job result while another process is reading the database', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'centrypto-app-db-'));
        const url = `file:${path.join(directory, 'app.db')}?connection_limit=1&socket_timeout=1`;
        const writer = new PrismaClient({ datasources: { db: { url } } });
        const reader = new PrismaClient({ datasources: { db: { url } } });
        try {
            await writer.$executeRawUnsafe('CREATE TABLE AnalysisJob (id TEXT PRIMARY KEY, status TEXT)');
            await writer.$executeRawUnsafe("INSERT INTO AnalysisJob VALUES ('job', 'running')");
            await Promise.all([ensureAppDbReady(writer), ensureAppDbReady(writer)]);

            // Use a deferred read transaction; Prisma's interactive transactions
            // start with BEGIN IMMEDIATE and intentionally acquire a write lock.
            await reader.$executeRawUnsafe('BEGIN');
            try {
                await reader.$queryRawUnsafe('SELECT * FROM AnalysisJob');
                // DELETE journaling blocks this commit until the reader releases
                // its transaction, reproducing the failed analysis-job update.
                await writer.$executeRawUnsafe("UPDATE AnalysisJob SET status = 'completed' WHERE id = 'job'");
            } finally {
                await reader.$executeRawUnsafe('ROLLBACK');
            }

            expect(await reader.$queryRawUnsafe('SELECT status FROM AnalysisJob')).toEqual([{ status: 'completed' }]);
            expect(await reader.$queryRawUnsafe('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }]);
        } finally {
            await Promise.all([writer.$disconnect(), reader.$disconnect()]);
            await rm(directory, { recursive: true, force: true });
        }
    });
});
