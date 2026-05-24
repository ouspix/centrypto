import { TradeSide } from "@/types/trading";

export function canonicalPlaybookForCandidate(
    playbook: string | null | undefined,
    eligiblePlaybooks: string[],
    side: TradeSide
): string | null {
    const requested = parsePlaybook(playbook);
    if (!requested) return null;

    for (const eligible of eligiblePlaybooks) {
        const candidate = parsePlaybook(eligible);
        if (!candidate) continue;
        if (candidate.base !== requested.base) continue;
        if (requested.side && candidate.side !== requested.side) continue;
        if (candidate.side !== side) continue;
        return eligible;
    }

    return null;
}

function parsePlaybook(playbook: string | null | undefined): { base: string; side: TradeSide | null } | null {
    if (!playbook) return null;
    const [rawBase, rawSide] = playbook.trim().replace(/_/g, " ").split(":");
    const base = rawBase.trim().toLowerCase().replace(/\s+/g, " ");
    const side = rawSide?.trim().toLowerCase();
    if (!base) return null;
    return {
        base,
        side: side === "long" || side === "short" ? side : null
    };
}
