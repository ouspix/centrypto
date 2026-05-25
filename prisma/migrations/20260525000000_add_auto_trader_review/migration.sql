CREATE TABLE "AutoTraderRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountAddress" TEXT NOT NULL,
    "agentWalletAddress" TEXT,
    "vaultAddress" TEXT,
    "subAccountAddress" TEXT,
    "network" TEXT NOT NULL,
    "cycleType" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "model" TEXT NOT NULL,
    "strategyVersion" TEXT,
    "promptVersion" TEXT,
    "validatorVersion" TEXT,
    "codeVersion" TEXT,
    "configHash" TEXT,
    "configJson" TEXT,
    "marketSnapshotId" INTEGER,
    "llmQueryId" INTEGER,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "reliableSince" DATETIME,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoTraderRun_llmQueryId_fkey" FOREIGN KEY ("llmQueryId") REFERENCES "LlmQuery" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "AutoTraderDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "decisionType" TEXT NOT NULL,
    "candidateId" TEXT,
    "positionSnapshotId" TEXT,
    "action" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT,
    "confidence" REAL,
    "skipReason" TEXT,
    "rawLlmDecisionJson" TEXT,
    "normalizedDecisionJson" TEXT,
    "validatorStatus" TEXT,
    "validatorErrorsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutoTraderDecision_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutoTraderRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutoTraderDecision_positionSnapshotId_fkey" FOREIGN KEY ("positionSnapshotId") REFERENCES "AutoTraderPositionSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "AutoTraderOrderAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT NOT NULL,
    "cloid" TEXT,
    "oid" TEXT,
    "batchId" TEXT,
    "batchIndex" INTEGER,
    "nonce" TEXT,
    "orderRole" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "positionSide" TEXT,
    "orderSide" TEXT NOT NULL,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "intendedSizeUsd" REAL,
    "intendedSizeCoin" REAL,
    "intendedLimitPx" REAL,
    "intendedStopLossPx" REAL,
    "intendedTakeProfitPx" REAL,
    "submittedAt" DATETIME,
    "exchangeReceivedAt" DATETIME,
    "latencyMs" INTEGER,
    "requestHash" TEXT,
    "status" TEXT NOT NULL,
    "statusReason" TEXT,
    "rawExchangeResponseJson" TEXT,
    "rawExchangeErrorJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoTraderOrderAttempt_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutoTraderDecision" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AutoTraderFill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountAddress" TEXT NOT NULL,
    "agentWalletAddress" TEXT,
    "network" TEXT NOT NULL,
    "rawCoin" TEXT NOT NULL,
    "normalizedSymbol" TEXT NOT NULL,
    "px" REAL NOT NULL,
    "sz" REAL NOT NULL,
    "side" TEXT,
    "dir" TEXT,
    "closedPnl" REAL NOT NULL DEFAULT 0,
    "fee" REAL NOT NULL DEFAULT 0,
    "hash" TEXT,
    "oid" TEXT,
    "cloid" TEXT,
    "tid" TEXT,
    "time" DATETIME NOT NULL,
    "fillType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "attributionStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "attributionMethod" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "orderAttemptId" TEXT,
    "decisionId" TEXT,
    "lifecycleId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "rawJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoTraderFill_orderAttemptId_fkey" FOREIGN KEY ("orderAttemptId") REFERENCES "AutoTraderOrderAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutoTraderFill_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutoTraderDecision" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutoTraderFill_lifecycleId_fkey" FOREIGN KEY ("lifecycleId") REFERENCES "AutoTraderTradeLifecycle" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "AutoTraderPositionSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "sizeUsd" REAL NOT NULL,
    "sizeCoin" REAL,
    "markPrice" REAL,
    "unrealizedPnl" REAL NOT NULL,
    "liquidationPrice" REAL,
    "leverage" REAL,
    "marginMode" TEXT,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawJson" TEXT,
    CONSTRAINT "AutoTraderPositionSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutoTraderRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AutoTraderTradeLifecycle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountAddress" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    "status" TEXT NOT NULL,
    "openFillIds" TEXT NOT NULL,
    "closeFillIds" TEXT NOT NULL,
    "attributedDecisionIds" TEXT NOT NULL,
    "attributedOrderAttemptIds" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "exitPrice" REAL,
    "sizeOpened" REAL NOT NULL,
    "sizeClosed" REAL NOT NULL DEFAULT 0,
    "grossRealizedPnl" REAL NOT NULL DEFAULT 0,
    "fees" REAL NOT NULL DEFAULT 0,
    "netRealizedPnl" REAL NOT NULL DEFAULT 0,
    "attributionMethod" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "reconstructionVersion" TEXT NOT NULL,
    "rawDebugJson" TEXT,
    "mfeBps" REAL,
    "maeBps" REAL,
    "mfeSource" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "mfeCoverage" TEXT NOT NULL DEFAULT 'NONE',
    "observedGreenToRed" BOOLEAN NOT NULL DEFAULT false,
    "lateGiveback" BOOLEAN NOT NULL DEFAULT false,
    "givebackPct" REAL,
    "runId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoTraderTradeLifecycle_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutoTraderRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "AutoTraderRun_accountAddress_network_startedAt_idx" ON "AutoTraderRun"("accountAddress", "network", "startedAt");
CREATE INDEX "AutoTraderRun_status_startedAt_idx" ON "AutoTraderRun"("status", "startedAt");
CREATE INDEX "AutoTraderRun_llmQueryId_idx" ON "AutoTraderRun"("llmQueryId");

CREATE INDEX "AutoTraderDecision_runId_idx" ON "AutoTraderDecision"("runId");
CREATE INDEX "AutoTraderDecision_symbol_action_createdAt_idx" ON "AutoTraderDecision"("symbol", "action", "createdAt");
CREATE INDEX "AutoTraderDecision_candidateId_idx" ON "AutoTraderDecision"("candidateId");
CREATE INDEX "AutoTraderDecision_positionSnapshotId_idx" ON "AutoTraderDecision"("positionSnapshotId");

CREATE INDEX "AutoTraderOrderAttempt_decisionId_idx" ON "AutoTraderOrderAttempt"("decisionId");
CREATE INDEX "AutoTraderOrderAttempt_cloid_idx" ON "AutoTraderOrderAttempt"("cloid");
CREATE INDEX "AutoTraderOrderAttempt_oid_idx" ON "AutoTraderOrderAttempt"("oid");
CREATE INDEX "AutoTraderOrderAttempt_symbol_submittedAt_idx" ON "AutoTraderOrderAttempt"("symbol", "submittedAt");

CREATE UNIQUE INDEX "AutoTraderFill_dedupeKey_key" ON "AutoTraderFill"("dedupeKey");
CREATE INDEX "AutoTraderFill_accountAddress_network_time_idx" ON "AutoTraderFill"("accountAddress", "network", "time");
CREATE INDEX "AutoTraderFill_normalizedSymbol_time_idx" ON "AutoTraderFill"("normalizedSymbol", "time");
CREATE INDEX "AutoTraderFill_oid_idx" ON "AutoTraderFill"("oid");
CREATE INDEX "AutoTraderFill_cloid_idx" ON "AutoTraderFill"("cloid");
CREATE INDEX "AutoTraderFill_tid_idx" ON "AutoTraderFill"("tid");
CREATE INDEX "AutoTraderFill_orderAttemptId_idx" ON "AutoTraderFill"("orderAttemptId");
CREATE INDEX "AutoTraderFill_decisionId_idx" ON "AutoTraderFill"("decisionId");
CREATE INDEX "AutoTraderFill_lifecycleId_idx" ON "AutoTraderFill"("lifecycleId");

CREATE INDEX "AutoTraderPositionSnapshot_runId_phase_idx" ON "AutoTraderPositionSnapshot"("runId", "phase");
CREATE INDEX "AutoTraderPositionSnapshot_symbol_observedAt_idx" ON "AutoTraderPositionSnapshot"("symbol", "observedAt");

CREATE INDEX "AutoTraderTradeLifecycle_accountAddress_network_openedAt_idx" ON "AutoTraderTradeLifecycle"("accountAddress", "network", "openedAt");
CREATE INDEX "AutoTraderTradeLifecycle_symbol_status_openedAt_idx" ON "AutoTraderTradeLifecycle"("symbol", "status", "openedAt");
CREATE INDEX "AutoTraderTradeLifecycle_observedGreenToRed_lateGiveback_idx" ON "AutoTraderTradeLifecycle"("observedGreenToRed", "lateGiveback");
CREATE INDEX "AutoTraderTradeLifecycle_runId_idx" ON "AutoTraderTradeLifecycle"("runId");
