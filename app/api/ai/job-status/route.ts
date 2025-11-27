import { NextResponse } from 'next/server';
import { OrchestratorService } from '@/services/OrchestratorService';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const jobId = searchParams.get('jobId');

        if (!jobId) {
            return NextResponse.json({ error: 'Job ID is required' }, { status: 400 });
        }

        const orchestrator = OrchestratorService.getInstance();
        const status = await orchestrator.getJobStatus(jobId);

        if (!status) {
            return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        }

        return NextResponse.json(status);

    } catch (error) {
        console.error('Job Status Error:', error);
        return NextResponse.json({
            error: 'Failed to fetch job status',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
