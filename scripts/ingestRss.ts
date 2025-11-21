import 'dotenv/config';
import { prisma } from '../lib/db';
import { ingestRss } from '../sentiment/pipeline';

ingestRss()
  .catch((err) => {
    console.error('RSS ingestion error', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
