-- Persist pre/post-risk decision state for review and export accuracy.
ALTER TABLE "AutoTraderDecision" ADD COLUMN "preRiskDecisionJson" TEXT;
ALTER TABLE "AutoTraderDecision" ADD COLUMN "riskAssessmentJson" TEXT;
ALTER TABLE "AutoTraderDecision" ADD COLUMN "finalDecisionJson" TEXT;
ALTER TABLE "AutoTraderDecision" ADD COLUMN "finalRiskPlanJson" TEXT;
ALTER TABLE "AutoTraderDecision" ADD COLUMN "submittedOrderPlanJson" TEXT;

-- Split open risk flags from closed outcome flags and store close attribution.
ALTER TABLE "AutoTraderTradeLifecycle" ADD COLUMN "openWasGreenNowRed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutoTraderTradeLifecycle" ADD COLUMN "openLateGiveback" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutoTraderTradeLifecycle" ADD COLUMN "openGivebackPct" REAL;
ALTER TABLE "AutoTraderTradeLifecycle" ADD COLUMN "closedGreenToRed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutoTraderTradeLifecycle" ADD COLUMN "closedLateGiveback" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutoTraderTradeLifecycle" ADD COLUMN "closeAction" TEXT;
ALTER TABLE "AutoTraderTradeLifecycle" ADD COLUMN "closeReasonCode" TEXT;
ALTER TABLE "AutoTraderTradeLifecycle" ADD COLUMN "closeAttemptStatus" TEXT;

CREATE INDEX "AutoTraderTradeLifecycle_openWasGreenNowRed_openLateGiveback_idx" ON "AutoTraderTradeLifecycle"("openWasGreenNowRed", "openLateGiveback");
CREATE INDEX "AutoTraderTradeLifecycle_closedGreenToRed_closedLateGiveback_idx" ON "AutoTraderTradeLifecycle"("closedGreenToRed", "closedLateGiveback");

-- Deterministic position-management state and reviewable events.
CREATE TABLE "AutoTraderPositionState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountAddress" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "lifecycleId" TEXT,
  "symbol" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "entryPrice" REAL NOT NULL,
  "openedAt" DATETIME NOT NULL,
  "highestMfeBps" REAL,
  "lowestMaeBps" REAL,
  "peakUnrealizedPnl" REAL,
  "partialTakenFraction" REAL NOT NULL DEFAULT 0,
  "protectedAt" DATETIME,
  "lastActionAt" DATETIME,
  "lastAction" TEXT,
  "lastReasonCode" TEXT,
  "lastStopPx" REAL,
  "lastTakeProfitPx" REAL,
  "policyVersion" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "AutoTraderPositionState_accountAddress_network_symbol_side_openedAt_key"
  ON "AutoTraderPositionState"("accountAddress", "network", "symbol", "side", "openedAt");
CREATE INDEX "AutoTraderPositionState_accountAddress_network_symbol_idx"
  ON "AutoTraderPositionState"("accountAddress", "network", "symbol");
CREATE INDEX "AutoTraderPositionState_lifecycleId_idx"
  ON "AutoTraderPositionState"("lifecycleId");

CREATE TABLE "AutoTraderPositionManagementEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountAddress" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "runId" TEXT,
  "lifecycleId" TEXT,
  "positionStateId" TEXT,
  "symbol" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "stateBefore" TEXT NOT NULL,
  "stateAfter" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "urgency" TEXT NOT NULL,
  "bypassLlm" BOOLEAN NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "notes" TEXT,
  "targetSizeFractionOfEquity" REAL,
  "reduceFraction" REAL,
  "stopReplacementJson" TEXT,
  "takeProfitReplacementJson" TEXT,
  "cancelOrderOidsJson" TEXT,
  "evidenceJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AutoTraderPositionManagementEvent_accountAddress_network_createdAt_idx"
  ON "AutoTraderPositionManagementEvent"("accountAddress", "network", "createdAt");
CREATE INDEX "AutoTraderPositionManagementEvent_symbol_createdAt_idx"
  ON "AutoTraderPositionManagementEvent"("symbol", "createdAt");
CREATE INDEX "AutoTraderPositionManagementEvent_lifecycleId_idx"
  ON "AutoTraderPositionManagementEvent"("lifecycleId");
CREATE INDEX "AutoTraderPositionManagementEvent_reasonCode_idx"
  ON "AutoTraderPositionManagementEvent"("reasonCode");
