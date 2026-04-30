import { NextResponse } from 'next/server';
import { requireWalletSession, WalletSessionError } from '@/lib/auth/wallet-session';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const session = requireWalletSession(request);
        const { searchParams } = new URL(request.url);
        const jobId = searchParams.get('jobId');

        if (!jobId) {
            return NextResponse.json({ error: 'Job ID is required' }, { status: 400 });
        }

        const job = await prisma.analysisJob.findFirst({
            where: { id: jobId, userAddress: session.address }
        });

        if (!job) {
            return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        }

        return NextResponse.json({
            id: job.id,
            status: job.status,
            result: job.result ? JSON.parse(job.result) : null,
            error: job.error,
            createdAt: job.createdAt,
            completedAt: job.completedAt
        });

    } catch (error) {
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('Job Status Error:', error);
        return NextResponse.json({
            error: 'Failed to fetch job status',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
