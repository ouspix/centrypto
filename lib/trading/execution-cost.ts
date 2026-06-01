export type ExecutionCostInput = {
    spreadBps: number;
    feesBps: number;
    slippageModel: {
        min_bps: number;
        spread_mult: number;
        depth_mult?: number;
    };
};

export type ExecutionCost = {
    feesBps: number;
    slippageBps: number;
    totalCostBps: number;
};

export function computeExecutionCostBps(input: ExecutionCostInput): ExecutionCost {
    const spreadBps = Math.max(0, input.spreadBps || 0);
    const slippageBps = Math.max(
        input.slippageModel.min_bps,
        spreadBps * input.slippageModel.spread_mult
    );

    return {
        feesBps: input.feesBps,
        slippageBps,
        totalCostBps: spreadBps + input.feesBps + slippageBps
    };
}
