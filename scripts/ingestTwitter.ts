import 'dotenv/config';
import { prisma } from '../lib/db';
import { ingestTwitter } from '../sentiment/pipeline';

ingestTwitter()
  .catch((err) => {
    console.error('Twitter ingestion error', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
