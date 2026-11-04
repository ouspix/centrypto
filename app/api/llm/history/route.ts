import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { InternalAuthError, requireInternalRequest } from "@/lib/auth/internal";

export const dynamic = 'force-dynamic';

type OrderAttemptSummary = {
    status: string;
    statusReason: string | null;
    orderRole: string;
    oid: string | null;
};

export async function GET(request: Request) {
    try {
        requireInternalRequest(request);
        const { searchParams } = new URL(request.url);
        const isTestnet = searchParams.get('isTestnet') === 'true';
        const history = await prisma.llmQuery.findMany({
            where: {
                isTestnet: isTestnet
            },
            include: {
                decisions: true,
                autoTraderRuns: {
                    include: {
                        decisions: {
                            include: {
                                orderAttempts: true
                            }
                        }
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            },
            take: 50
        });

        return NextResponse.json(history.map(llmQueryDto));
    } catch (error) {
        if (error instanceof InternalAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error("Failed to fetch LLM history:", error);
        return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
    }
}

function llmQueryDto(query: any) {
    const backendDecisions = (query.autoTraderRuns ?? []).flatMap((run: any) =>
        (run.decisions ?? []).map((decision: any) => ({
            ...decision,
            runStatus: run.status,
            runStartedAt: run.startedAt
        }))
    );
    const usedBackendDecisionIds = new Set<string>();

    return {
        id: query.id,
        prompt: query.prompt,
        response: query.response,
        createdAt: query.createdAt,
        isTestnet: query.isTestnet,
        decisions: (query.decisions ?? []).map((decision: any) => {
            const backendDecision = backendDecisions.find((candidate: any) => {
                if (usedBackendDecisionIds.has(candidate.id)) return false;
                if (candidate.symbol !== decision.symbol || candidate.action !== decision.action) return false;
                if (decision.side && candidate.side && candidate.side !== decision.side) return false;
                return true;
            });
            if (backendDecision?.id) usedBackendDecisionIds.add(backendDecision.id);

            const execution = executionSummary(backendDecision);
            return {
                id: decision.id,
                action: decision.action,
                symbol: decision.symbol,
                confidence: decision.confidence,
                reasonCode: decision.reasonCode,
                notes: decision.notes,
                side: decision.side,
                sizeFraction: decision.sizeFraction,
                backendDecisionId: backendDecision?.id ?? null,
                validatorStatus: backendDecision?.validatorStatus ?? null,
                executionStatus: execution.status,
                executionReason: execution.reason,
                orderAttempts: execution.orderAttempts
            };
        })
    };
}

function executionSummary(decision: any): {
    status: string | null;
    reason: string | null;
    orderAttempts: OrderAttemptSummary[];
} {
    if (!decision) return { status: null, reason: null, orderAttempts: [] };
    const attempts = decision.orderAttempts ?? [];
    const orderAttempts: OrderAttemptSummary[] = attempts.map((attempt: any) => ({
        status: String(attempt.status ?? "UNKNOWN"),
        statusReason: attempt.statusReason ?? null,
        orderRole: String(attempt.orderRole ?? "ORDER"),
        oid: attempt.oid ?? null
    }));

    if (orderAttempts.length === 0) {
        if (decision.validatorStatus && decision.validatorStatus !== "accepted") {
            return {
                status: "REJECTED",
                reason: parseFirstJsonString(decision.validatorErrorsJson) ?? decision.skipReason ?? decision.validatorStatus,
                orderAttempts
            };
        }
        return { status: null, reason: null, orderAttempts };
    }

    const statuses: string[] = orderAttempts.map((attempt: OrderAttemptSummary) => attempt.status);
    const reason = orderAttempts.find((attempt: OrderAttemptSummary) => attempt.statusReason)?.statusReason ?? null;
    if (statuses.some((status: string) => status === "FILLED" || status === "FILLED_FROM_SYNC")) {
        return { status: "FILLED", reason, orderAttempts };
    }
    if (statuses.some((status: string) => status === "RESTING")) {
        return { status: "RESTING", reason, orderAttempts };
    }
    if (statuses.some((status: string) => status === "SUBMITTED")) {
        return { status: "SUBMITTED", reason, orderAttempts };
    }
    if (statuses.some((status: string) => status === "FAILED" || status === "ERROR")) {
        return { status: "FAILED", reason, orderAttempts };
    }
    if (statuses.some((status: string) => status === "CANCELED" || status === "NOT_FOUND_ON_EXCHANGE")) {
        return { status: "CANCELED", reason, orderAttempts };
    }
    return { status: statuses[0] ?? "UNKNOWN", reason, orderAttempts };
}

function parseFirstJsonString(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.find(item => typeof item === "string") ?? null;
        return typeof parsed === "string" ? parsed : null;
    } catch {
        return value;
    }
}
