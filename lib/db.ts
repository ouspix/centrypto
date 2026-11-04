import path from 'path';
import { PrismaClient } from '@prisma/client';

export function appDatabaseUrl(url: string): string {
  if (!url.startsWith('file:')) return url;
  const [file, query = ''] = url.split('?');
  const parameters = new URLSearchParams(query);
  // SQLite has one writer. Queue this process's work in the pool instead of
  // spending every connection waiting for the same write lock.
  if (!parameters.has('connection_limit')) parameters.set('connection_limit', '1');
  if (!parameters.has('socket_timeout')) parameters.set('socket_timeout', '5');
  return `${file}?${parameters}`;
}

process.env.DATABASE_URL = appDatabaseUrl(
  process.env.DATABASE_URL ?? `file:${path.join(process.cwd(), 'prisma', 'backend.db')}`,
);

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

const readyClients = new WeakMap<PrismaClient, Promise<void>>();

// The web app and inference worker share this file. WAL lets job-status reads
// coexist with writes instead of timing out while a result is being saved.
export function ensureAppDbReady(client: PrismaClient = prisma): Promise<void> {
  const ready = readyClients.get(client);
  if (ready) return ready;

  const initializing = client.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode = WAL')
    .then(rows => {
      if (rows[0]?.journal_mode !== 'wal') {
        throw new Error('Application database requires SQLite WAL mode');
      }
    })
    .catch(error => {
      readyClients.delete(client);
      throw error;
    });
  readyClients.set(client, initializing);
  return initializing;
}
