import type { DeskIntent } from "@prisma/client";
import { LIVE_ORDER_STATES } from "./execution-risk";

type PendingIntent = Pick<DeskIntent,"instrumentId"|"quantity"|"filledQty"|"reservedUsd"|"limitPrice"|"side"|"state"|"requestJson">;
/** Notional consumes capital; stop distance plus costs consumes loss budget.
 * Unknown submissions / invalid plans retain full-notional risk conservatively.
 * Filled quantity is already represented by the separately assessed position. */
export function pendingOrderExposure(order:PendingIntent,costAllowanceBps:number){
    if(!LIVE_ORDER_STATES.includes(order.state)||order.reservedUsd===0)return {notionalUsd:0,riskUsd:0,remainingQuantity:0,basis:"none" as const};
    const {quantity,filledQty,reservedUsd,limitPrice}=order;
    if(![quantity,filledQty,reservedUsd,limitPrice,costAllowanceBps].every(Number.isFinite)||quantity<=0||filledQty<0||reservedUsd<0||limitPrice<=0||costAllowanceBps<0)throw new Error("Invalid pending order exposure");
    const uncertain=["submitting","unknown","blocked"].includes(order.state);
    const remainingQuantity=uncertain?quantity:Math.max(0,quantity-filledQty);
    const notionalUsd=reservedUsd*remainingQuantity/quantity;
    let request:Record<string,unknown>={};try{request=JSON.parse(order.requestJson);}catch{/* preserve conservative risk */}
    const stop=request?.stopPrice;
    const validStop=typeof stop==="number"&&Number.isFinite(stop)&&stop>0&&(order.side==="buy"?stop<limitPrice:order.side==="sell"&&stop>limitPrice);
    if(!uncertain&&order.instrumentId.includes(":perp:")&&validStop&&request.reduceOnly!==true){
        return {notionalUsd,riskUsd:notionalUsd*(Math.abs(limitPrice-stop!)/limitPrice+costAllowanceBps/10000),remainingQuantity,basis:"stop_and_costs" as const};
    }
    return {notionalUsd,riskUsd:notionalUsd,remainingQuantity,basis:"conservative_notional" as const};
}
