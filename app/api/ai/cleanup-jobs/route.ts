import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { InternalAuthError, requireInternalRequest } from '@/lib/auth/internal';

export async function POST(request: Request) {
    try {
        requireInternalRequest(request);
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Delete completed jobs older than 1 hour
        const deletedCompleted = await prisma.analysisJob.deleteMany({
            where: {
                status: 'completed',
                createdAt: { lt: oneHourAgo }
            }
        });

        // Delete failed/cancelled jobs older than 24 hours
        const deletedFailed = await prisma.analysisJob.deleteMany({
            where: {
                status: { in: ['failed', 'cancelled'] },
                createdAt: { lt: twentyFourHoursAgo }
            }
        });

        // Delete pending/running jobs older than 1 hour (stuck jobs)
        const deletedStuck = await prisma.analysisJob.deleteMany({
            where: {
                status: { in: ['pending', 'running'] },
                createdAt: { lt: oneHourAgo }
            }
        });

        return NextResponse.json({
            success: true,
            deleted: {
                completed: deletedCompleted.count,
                failed: deletedFailed.count,
                stuck: deletedStuck.count
            }
        });

    } catch (error) {
        if (error instanceof InternalAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('Cleanup Error:', error);
        return NextResponse.json({
            error: 'Cleanup failed',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
