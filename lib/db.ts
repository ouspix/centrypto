import path from 'path';
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  // Provide a sane default for local/dev usage so API routes don't crash.
  // Use an absolute path to avoid Next.js working-directory surprises (.next/server).
  const dbPath = path.join(process.cwd(), 'prisma', 'backend.db');
  process.env.DATABASE_URL = `file:${dbPath}`;
  console.warn('DATABASE_URL not set; defaulting to local prisma/backend.db');
}

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
