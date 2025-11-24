import { NextResponse } from 'next/server';
import { OrchestratorService } from '@/services/OrchestratorService';

export async function POST(request: Request) {
    try {
        const orchestrator = OrchestratorService.getInstance();
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
