import { NextResponse } from 'next/server';
import { OrchestratorService } from '@/services/OrchestratorService';

export async function POST(request: Request) {
    try {
        const orchestrator = OrchestratorService.getInstance();

        // Check for jobId in body
        let jobId: string | undefined;
        try {
            const body = await request.json();
            jobId = body.jobId;
        } catch (e) {
            // Body might be empty, which is fine for legacy cancel
        }

        if (jobId) {
            const success = await orchestrator.cancelJob(jobId);
            if (success) {
                return NextResponse.json({ success: true, message: `Job ${jobId} cancelled` });
            } else {
                return NextResponse.json({ success: false, message: `Job ${jobId} not found or already completed` }, { status: 404 });
            }
        }

        // Legacy behavior
        orchestrator.cancelCurrentRequest();

        console.log('🚫 Cancel request received');

        return NextResponse.json({
            success: true,
            message: 'Analysis cancelled (client-side only - Ollama may continue processing)'
        });
    } catch (error) {
        console.error('Cancel Error:', error);
        return NextResponse.json({
            error: 'Cancel failed',
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
