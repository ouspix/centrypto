import 'dotenv/config';
import { prisma } from '../lib/db';
import { scorePendingMessages } from '../sentiment/pipeline';

scorePendingMessages()
  .catch((err) => {
    console.error('Scoring error', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
