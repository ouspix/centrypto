// @vitest-environment node
import {describe,it,expect} from "vitest";
import {pendingOrderExposure} from "@/lib/desk/pending-exposure";
const order={instrumentId:"mainnet:perp:BTC",quantity:10,filledQty:0,reservedUsd:1000,limitPrice:100,side:"buy",state:"working",requestJson:JSON.stringify({stopPrice:98})};
describe("pending order capital and risk",()=>{
 it("separates stop-plus-cost risk from capital and counts only the unfilled remainder",()=>{
  expect(pendingOrderExposure(order,50)).toMatchObject({notionalUsd:1000,riskUsd:25,remainingQuantity:10});
  expect(pendingOrderExposure({...order,filledQty:4},50)).toMatchObject({notionalUsd:600,riskUsd:15,remainingQuantity:6});
  expect(pendingOrderExposure({...order,side:"sell",requestJson:JSON.stringify({stopPrice:103})},50).riskUsd).toBeCloseTo(35);
 });
 it("preserves conservative risk for ambiguous submissions, missing stops and spot exposure",()=>{
  for(const extra of [{state:"unknown",filledQty:4},{requestJson:"{}"},{requestJson:"invalid"},{requestJson:JSON.stringify({stopPrice:101})},{instrumentId:"mainnet:spot:BTC"}])expect(pendingOrderExposure({...order,...extra},50).riskUsd).toBe(1000);
 });
 it("does not consume risk for completed orders or zero-reservation protective exits",()=>{
  expect(pendingOrderExposure({...order,state:"filled"},50).riskUsd).toBe(0);
  expect(pendingOrderExposure({...order,reservedUsd:0,requestJson:JSON.stringify({reduceOnly:true})},50)).toMatchObject({notionalUsd:0,riskUsd:0});
 });
});
