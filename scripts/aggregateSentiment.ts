import 'dotenv/config';
import { prisma } from '../lib/db';
import { aggregateSnapshots } from '../sentiment/pipeline';

aggregateSnapshots()
  .catch((err) => {
    console.error('Aggregation error', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
