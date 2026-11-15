/** Recover only acknowledged journal writes, never replay tools or trading authority. */
export function recoverPortfolioComparisons(calls: Array<{ id: number; key: string; bookId: string; shiftId: string | null; role: string; createdAt: Date; dataJson: string }>,
    receipts: Map<string, { id: number; createdAt: Date; data: any }>,
    contexts: Map<string, { bookVersion: number; portfolio: unknown; mode: string }>) {
    const recovered = new Map<string, { bookId: string; shiftId: string; key: string; role: string; kind: string; createdAt: Date; dataJson: string }>();
    for (const call of [...calls].sort((a, b) => +a.createdAt - +b.createdAt || a.id - b.id)) {
        const tool = JSON.parse(call.dataJson), receipt = receipts.get(call.key + ":result");
        const context = call.shiftId ? contexts.get(call.shiftId) : null;
        if (!call.shiftId || !context || !receipt || receipt.data?.error || receipt.data?.portfolioRecorded !== true) continue;
        const comparison = tool.name === "record_portfolio_comparison" ? tool.args : tool.name === "record_candidate_comparison" ? tool.args?.portfolioChoice : null;
        if (!comparison?.holdingInstrumentId || !comparison.choice) continue;
        const key = `portfolio-comparison:${call.shiftId}:${call.role}:${comparison.holdingInstrumentId}`;
        recovered.set(call.bookId + ":" + key, { bookId: call.bookId, shiftId: call.shiftId, key, role: call.role,
            kind: "portfolio_comparison", createdAt: receipt.createdAt, dataJson: JSON.stringify({ ...comparison, ...context,
                at: receipt.createdAt.toISOString(), recovery: { toolRecordId: call.id, receiptRecordId: receipt.id,
                    historical: true, instruction: "Recovered acknowledged historical journal. No reanalysis, fresh evidence or execution authority." } }) });
    }
    return [...recovered.values()];
}
