import { DIRECTIONAL_HOST_LIMITS, LEGACY_SIZING_DEFAULTS, type DeskMandate } from "./mandate";
export function sizeSwingRisk(input:{entry:number;stop:number;side:"buy"|"sell";equityUsd:number;committedUsd:number;openRiskUsd:number;instrumentUsd:number;depthUsd:number;szDecimals:number;mandate:DeskMandate}) {
    const {entry,stop,mandate:m}=input;
    if(![entry,stop,input.equityUsd,input.depthUsd,input.committedUsd,input.openRiskUsd,input.instrumentUsd].every(Number.isFinite)||Math.min(entry,stop)<=0||(input.side==="buy"?stop>=entry:stop<=entry))throw new Error("Invalid entry, stop or portfolio inputs");
    const costBps=m.costAllowanceBps??LEGACY_SIZING_DEFAULTS.costAllowanceBps,riskFraction=Math.abs(entry-stop)/entry+costBps/10000;
    const riskBudget=Math.max(0,Math.min(m.maxRiskPerTradeUsd,(m.maxOpenRiskUsd??m.maxRiskPerTradeUsd*2)-input.openRiskUsd));
    const usable=Math.max(0,Math.min(DIRECTIONAL_HOST_LIMITS.capitalUsd,m.capitalUsd,input.equityUsd)*Math.min(DIRECTIONAL_HOST_LIMITS.sizingGrossLeverage,m.maxGrossLeverage)-input.committedUsd);
    const notional=Math.max(0,Math.min(riskBudget/riskFraction,m.maxOrderUsd,m.maxInstrumentUsd-input.instrumentUsd,usable,input.depthUsd));
    const scale=10**input.szDecimals,quantity=Math.floor(notional/entry*scale)/scale,usd=quantity*entry;
    return {quantity:usd>=10&&input.depthUsd>=m.minDepthUsd?quantity:0,notionalUsd:usd,plannedLossUsd:usd*riskFraction,riskBudgetUsd:riskBudget,usableCapitalUsd:usable,costAllowanceBps:costBps,
        status:usd<10?"below_minimum":input.depthUsd<m.minDepthUsd?"insufficient_depth":"sized_for_preview",
        note:"Stop loss plus conservative round-trip cost allowance; gaps can exceed planned loss. Host preview repeats fresh portfolio and execution checks. This is not an order."};
}
