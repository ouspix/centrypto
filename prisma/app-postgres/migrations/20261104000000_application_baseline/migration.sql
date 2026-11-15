-- CreateTable
CREATE TABLE "LlmQuery" (
    "id" SERIAL NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LlmQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmDecision" (
    "id" SERIAL NOT NULL,
    "queryId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCode" TEXT,
    "notes" TEXT,
    "side" TEXT,
    "sizeFraction" DOUBLE PRECISION,
    "targetSide" TEXT,
    "targetSize" DOUBLE PRECISION,
    "playbook" TEXT,
    "riskPlan" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketStateSnapshot" (
    "id" SERIAL NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketStateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningSnapshot" (
    "id" SERIAL NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreeningSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateJournal" (
    "id" SERIAL NOT NULL,
    "snapshotId" INTEGER,
    "timestamp" INTEGER NOT NULL,
    "profile" TEXT,
    "regime" TEXT NOT NULL,
    "candidateId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT,
    "playbook" TEXT,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "llmAction" TEXT,
    "llmConfidence" DOUBLE PRECISION,
    "llmNotes" TEXT,
    "validatorStatus" TEXT,
    "validatorReason" TEXT,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "promotionReason" TEXT,
    "demotionReason" TEXT,
    "matchedPriorBucket" TEXT,
    "configEpoch" TIMESTAMP(3),
    "metadataJson" TEXT,
    "outcome5mBps" DOUBLE PRECISION,
    "outcome15mBps" DOUBLE PRECISION,
    "outcome1hBps" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityJournal" (
    "id" TEXT NOT NULL,
    "accountAddress" TEXT,
    "network" TEXT NOT NULL,
    "snapshotId" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "discoveryReasonsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inPlayScore" DOUBLE PRECISION,
    "setupType" TEXT,
    "setupScore" DOUBLE PRECISION,
    "playbook" TEXT,
    "reasonsJson" TEXT NOT NULL,
    "warningsJson" TEXT NOT NULL,
    "featuresJson" TEXT NOT NULL,
    "executionTradeable" BOOLEAN NOT NULL,
    "executionBlockReasonsJson" TEXT NOT NULL,
    "promotionReason" TEXT,
    "demotionReason" TEXT,
    "matchedPriorBucket" TEXT,
    "configEpoch" TIMESTAMP(3),
    "pathQuality" TEXT,
    "policyOutcome" TEXT,
    "priceAtSignal" DOUBLE PRECISION,
    "outcome5mJson" TEXT,
    "outcome15mJson" TEXT,
    "outcome1hJson" TEXT,
    "outcome4hJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL NOT NULL,
    "externalId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "likeCount" INTEGER,
    "retweetCount" INTEGER,
    "replyCount" INTEGER,
    "sentimentScore" DOUBLE PRECISION,
    "sentimentConf" DOUBLE PRECISION,
    "tagsJson" TEXT,
    "language" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymbolBaseline" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "avgMentions24h" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SymbolBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymbolSentimentSnapshot" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "change2h" DOUBLE PRECISION NOT NULL,
    "mentions" INTEGER NOT NULL,
    "mentionsVsBaseline" DOUBLE PRECISION NOT NULL,
    "disagreement" DOUBLE PRECISION NOT NULL,
    "sourceMixJson" TEXT NOT NULL,
    "tagsJson" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SymbolSentimentSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "exitPrice" DOUBLE PRECISION,
    "size" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "realizedPnl" DOUBLE PRECISION,
    "fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "userAddress" TEXT NOT NULL,
    "strategyName" TEXT,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceAlert" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "targetPrice" DOUBLE PRECISION NOT NULL,
    "percentChange" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggeredAt" TIMESTAMP(3),
    "userAddress" TEXT NOT NULL,

    CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisJob" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "userAddress" TEXT,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,
    "model" TEXT NOT NULL,
    "config" TEXT,
    "result" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AnalysisJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTraderSettings" (
    "id" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequencySeconds" INTEGER NOT NULL DEFAULT 600,
    "model" TEXT NOT NULL,
    "config" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTraderSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTraderRun" (
    "id" TEXT NOT NULL,
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
    "reliableSince" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTraderRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTraderDecision" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "decisionType" TEXT NOT NULL,
    "candidateId" TEXT,
    "positionSnapshotId" TEXT,
    "action" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT,
    "confidence" DOUBLE PRECISION,
    "skipReason" TEXT,
    "rawLlmDecisionJson" TEXT,
    "normalizedDecisionJson" TEXT,
    "preRiskDecisionJson" TEXT,
    "riskAssessmentJson" TEXT,
    "finalDecisionJson" TEXT,
    "finalRiskPlanJson" TEXT,
    "submittedOrderPlanJson" TEXT,
    "validatorStatus" TEXT,
    "validatorErrorsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoTraderDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTraderOrderAttempt" (
    "id" TEXT NOT NULL,
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
    "intendedSizeUsd" DOUBLE PRECISION,
    "intendedSizeCoin" DOUBLE PRECISION,
    "intendedLimitPx" DOUBLE PRECISION,
    "intendedStopLossPx" DOUBLE PRECISION,
    "intendedTakeProfitPx" DOUBLE PRECISION,
    "submittedAt" TIMESTAMP(3),
    "exchangeReceivedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "requestHash" TEXT,
    "status" TEXT NOT NULL,
    "statusReason" TEXT,
    "rawExchangeResponseJson" TEXT,
    "rawExchangeErrorJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTraderOrderAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTraderFill" (
    "id" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "agentWalletAddress" TEXT,
    "network" TEXT NOT NULL,
    "rawCoin" TEXT NOT NULL,
    "normalizedSymbol" TEXT NOT NULL,
    "px" DOUBLE PRECISION NOT NULL,
    "sz" DOUBLE PRECISION NOT NULL,
    "side" TEXT,
    "dir" TEXT,
    "closedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hash" TEXT,
    "oid" TEXT,
    "cloid" TEXT,
    "tid" TEXT,
    "time" TIMESTAMP(3) NOT NULL,
    "fillType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "attributionStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "attributionMethod" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "orderAttemptId" TEXT,
    "decisionId" TEXT,
    "lifecycleId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "rawJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTraderFill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTraderPositionSnapshot" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "sizeUsd" DOUBLE PRECISION NOT NULL,
    "sizeCoin" DOUBLE PRECISION,
    "markPrice" DOUBLE PRECISION,
    "unrealizedPnl" DOUBLE PRECISION NOT NULL,
    "liquidationPrice" DOUBLE PRECISION,
    "leverage" DOUBLE PRECISION,
    "marginMode" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawJson" TEXT,

    CONSTRAINT "AutoTraderPositionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTraderTradeLifecycle" (
    "id" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "openFillIds" TEXT NOT NULL,
    "closeFillIds" TEXT NOT NULL,
    "attributedDecisionIds" TEXT NOT NULL,
    "attributedOrderAttemptIds" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "exitPrice" DOUBLE PRECISION,
    "sizeOpened" DOUBLE PRECISION NOT NULL,
    "sizeClosed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grossRealizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netRealizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "attributionMethod" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "reconstructionVersion" TEXT NOT NULL,
    "rawDebugJson" TEXT,
    "mfeBps" DOUBLE PRECISION,
    "maeBps" DOUBLE PRECISION,
    "mfeSource" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "mfeCoverage" TEXT NOT NULL DEFAULT 'NONE',
    "observedGreenToRed" BOOLEAN NOT NULL DEFAULT false,
    "lateGiveback" BOOLEAN NOT NULL DEFAULT false,
    "givebackPct" DOUBLE PRECISION,
    "openWasGreenNowRed" BOOLEAN NOT NULL DEFAULT false,
    "openLateGiveback" BOOLEAN NOT NULL DEFAULT false,
    "openGivebackPct" DOUBLE PRECISION,
    "closedGreenToRed" BOOLEAN NOT NULL DEFAULT false,
    "closedLateGiveback" BOOLEAN NOT NULL DEFAULT false,
    "closeAction" TEXT,
    "closeReasonCode" TEXT,
    "closeAttemptStatus" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTraderTradeLifecycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTraderPositionState" (
    "id" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "lifecycleId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "highestMfeBps" DOUBLE PRECISION,
    "lowestMaeBps" DOUBLE PRECISION,
    "peakUnrealizedPnl" DOUBLE PRECISION,
    "partialTakenFraction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "protectedAt" TIMESTAMP(3),
    "lastActionAt" TIMESTAMP(3),
    "lastAction" TEXT,
    "lastReasonCode" TEXT,
    "lastStopPx" DOUBLE PRECISION,
    "lastTakeProfitPx" DOUBLE PRECISION,
    "policyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTraderPositionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTraderPositionManagementEvent" (
    "id" TEXT NOT NULL,
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
    "targetSizeFractionOfEquity" DOUBLE PRECISION,
    "reduceFraction" DOUBLE PRECISION,
    "stopReplacementJson" TEXT,
    "takeProfitReplacementJson" TEXT,
    "cancelOrderOidsJson" TEXT,
    "evidenceJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoTraderPositionManagementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletRiskControl" (
    "id" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletRiskControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserHyperliquidApiWallet" (
    "id" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,
    "apiWalletAddress" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL DEFAULT 'v1',
    "lastVerifiedAt" TIMESTAMP(3),
    "delegationValidUntil" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserHyperliquidApiWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsRunContext" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "snapshotId" INTEGER,
    "runId" TEXT,
    "briefingId" TEXT,
    "contextJson" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsRunContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodexJob" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "schemaJson" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "resultJson" TEXT,
    "errorCode" TEXT,
    "usageJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodexJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodexRuntime" (
    "id" TEXT NOT NULL DEFAULT 'local',
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "backoffUntil" TIMESTAMP(3),
    "cliVersion" TEXT,
    "modelsJson" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "CodexRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskPublicCache" (
    "id" SERIAL NOT NULL,
    "bookId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "DeskPublicCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskBook" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "isTestnet" BOOLEAN NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "mandateJson" TEXT NOT NULL,
    "frequencySeconds" INTEGER NOT NULL DEFAULT 600,
    "newsCursor" INTEGER NOT NULL DEFAULT 0,
    "nextReviewAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskWake" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "shiftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeskWake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskShift" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lease" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "briefJson" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "DeskShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskRecord" (
    "id" SERIAL NOT NULL,
    "bookId" TEXT NOT NULL,
    "shiftId" TEXT,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeskRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskWatch" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "instrumentId" TEXT,
    "eventKey" TEXT,
    "thesis" TEXT NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "threshold" DOUBLE PRECISION,
    "referencePrice" DOUBLE PRECISION,
    "side" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcomeJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeskWatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskIntent" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "intentKey" TEXT NOT NULL,
    "cloid" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "asset" INTEGER NOT NULL,
    "coin" TEXT NOT NULL,
    "requestJson" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "oid" TEXT,
    "arrivalPrice" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "limitPrice" DOUBLE PRECISION NOT NULL,
    "reservedUsd" DOUBLE PRECISION NOT NULL,
    "side" TEXT NOT NULL,
    "filledQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stopCloid" TEXT,
    "targetCloid" TEXT,
    "groupKey" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskInventory" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "basis" DOUBLE PRECISION NOT NULL,
    "realizedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fundingUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stopPrice" DOUBLE PRECISION,
    "targetPrice" DOUBLE PRECISION,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskCashFlow" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "venueKey" TEXT NOT NULL,
    "intentId" TEXT,
    "instrumentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "feeUsd" DOUBLE PRECISION NOT NULL,
    "pnlUsd" DOUBLE PRECISION NOT NULL,
    "shortfallUsd" DOUBLE PRECISION NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskCashFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskExecutionState" (
    "bookId" TEXT NOT NULL,
    "quoteJson" TEXT,
    "cancelAt" TIMESTAMP(3),
    "lastQuotedAt" TIMESTAMP(3),
    "lastSync" TIMESTAMP(3),
    "lastError" TEXT,
    "highWaterUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "drawdownUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPnlUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unrealizedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dailyPnlUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dayKey" TEXT,
    "dayStartUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskExecutionState_pkey" PRIMARY KEY ("bookId")
);

-- CreateTable
CREATE TABLE "DeskExecutionLease" (
    "key" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "nonce" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "DeskExecutionLease_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "DeskPair" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "intentKey" TEXT NOT NULL,
    "planJson" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskPair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskTokenUsage" (
    "threadId" TEXT NOT NULL,
    "bookId" TEXT,
    "shiftId" TEXT,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "turnId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3),
    "totalTokens" BIGINT,
    "inputTokens" BIGINT,
    "cachedInputTokens" BIGINT,
    "cacheWriteInputTokens" BIGINT,
    "outputTokens" BIGINT,
    "reasoningOutputTokens" BIGINT,

    CONSTRAINT "DeskTokenUsage_pkey" PRIMARY KEY ("threadId")
);

-- CreateTable
CREATE TABLE "DeskTokenMeterEpoch" (
    "id" INTEGER NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeskTokenMeterEpoch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateJournal_snapshotId_idx" ON "CandidateJournal"("snapshotId");

-- CreateIndex
CREATE INDEX "CandidateJournal_symbol_createdAt_idx" ON "CandidateJournal"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "CandidateJournal_status_createdAt_idx" ON "CandidateJournal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CandidateJournal_candidateId_idx" ON "CandidateJournal"("candidateId");

-- CreateIndex
CREATE INDEX "OpportunityJournal_network_symbol_createdAt_idx" ON "OpportunityJournal"("network", "symbol", "createdAt");

-- CreateIndex
CREATE INDEX "OpportunityJournal_status_createdAt_idx" ON "OpportunityJournal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OpportunityJournal_setupType_createdAt_idx" ON "OpportunityJournal"("setupType", "createdAt");

-- CreateIndex
CREATE INDEX "Message_symbol_ts_idx" ON "Message"("symbol", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Message_externalId_source_symbol_key" ON "Message"("externalId", "source", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "SymbolBaseline_symbol_key" ON "SymbolBaseline"("symbol");

-- CreateIndex
CREATE INDEX "SymbolSentimentSnapshot_symbol_windowMinutes_updatedAt_idx" ON "SymbolSentimentSnapshot"("symbol", "windowMinutes", "updatedAt");

-- CreateIndex
CREATE INDEX "SymbolSentimentSnapshot_symbol_updatedAt_idx" ON "SymbolSentimentSnapshot"("symbol", "updatedAt");

-- CreateIndex
CREATE INDEX "Trade_openedAt_idx" ON "Trade"("openedAt");

-- CreateIndex
CREATE INDEX "Trade_symbol_userAddress_idx" ON "Trade"("symbol", "userAddress");

-- CreateIndex
CREATE INDEX "Trade_userAddress_status_idx" ON "Trade"("userAddress", "status");

-- CreateIndex
CREATE INDEX "PriceAlert_symbol_isActive_idx" ON "PriceAlert"("symbol", "isActive");

-- CreateIndex
CREATE INDEX "PriceAlert_userAddress_isActive_triggered_idx" ON "PriceAlert"("userAddress", "isActive", "triggered");

-- CreateIndex
CREATE INDEX "AnalysisJob_status_createdAt_idx" ON "AnalysisJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisJob_userAddress_status_idx" ON "AnalysisJob"("userAddress", "status");

-- CreateIndex
CREATE INDEX "AutoTraderSettings_enabled_nextRunAt_idx" ON "AutoTraderSettings"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "AutoTraderSettings_userAddress_enabled_idx" ON "AutoTraderSettings"("userAddress", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AutoTraderSettings_userAddress_isTestnet_key" ON "AutoTraderSettings"("userAddress", "isTestnet");

-- CreateIndex
CREATE INDEX "AutoTraderRun_accountAddress_network_startedAt_idx" ON "AutoTraderRun"("accountAddress", "network", "startedAt");

-- CreateIndex
CREATE INDEX "AutoTraderRun_status_startedAt_idx" ON "AutoTraderRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "AutoTraderRun_llmQueryId_idx" ON "AutoTraderRun"("llmQueryId");

-- CreateIndex
CREATE INDEX "AutoTraderDecision_runId_idx" ON "AutoTraderDecision"("runId");

-- CreateIndex
CREATE INDEX "AutoTraderDecision_symbol_action_createdAt_idx" ON "AutoTraderDecision"("symbol", "action", "createdAt");

-- CreateIndex
CREATE INDEX "AutoTraderDecision_candidateId_idx" ON "AutoTraderDecision"("candidateId");

-- CreateIndex
CREATE INDEX "AutoTraderDecision_positionSnapshotId_idx" ON "AutoTraderDecision"("positionSnapshotId");

-- CreateIndex
CREATE INDEX "AutoTraderOrderAttempt_decisionId_idx" ON "AutoTraderOrderAttempt"("decisionId");

-- CreateIndex
CREATE INDEX "AutoTraderOrderAttempt_cloid_idx" ON "AutoTraderOrderAttempt"("cloid");

-- CreateIndex
CREATE INDEX "AutoTraderOrderAttempt_oid_idx" ON "AutoTraderOrderAttempt"("oid");

-- CreateIndex
CREATE INDEX "AutoTraderOrderAttempt_symbol_submittedAt_idx" ON "AutoTraderOrderAttempt"("symbol", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutoTraderFill_dedupeKey_key" ON "AutoTraderFill"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutoTraderFill_accountAddress_network_time_idx" ON "AutoTraderFill"("accountAddress", "network", "time");

-- CreateIndex
CREATE INDEX "AutoTraderFill_normalizedSymbol_time_idx" ON "AutoTraderFill"("normalizedSymbol", "time");

-- CreateIndex
CREATE INDEX "AutoTraderFill_oid_idx" ON "AutoTraderFill"("oid");

-- CreateIndex
CREATE INDEX "AutoTraderFill_cloid_idx" ON "AutoTraderFill"("cloid");

-- CreateIndex
CREATE INDEX "AutoTraderFill_tid_idx" ON "AutoTraderFill"("tid");

-- CreateIndex
CREATE INDEX "AutoTraderFill_orderAttemptId_idx" ON "AutoTraderFill"("orderAttemptId");

-- CreateIndex
CREATE INDEX "AutoTraderFill_decisionId_idx" ON "AutoTraderFill"("decisionId");

-- CreateIndex
CREATE INDEX "AutoTraderFill_lifecycleId_idx" ON "AutoTraderFill"("lifecycleId");

-- CreateIndex
CREATE INDEX "AutoTraderPositionSnapshot_runId_phase_idx" ON "AutoTraderPositionSnapshot"("runId", "phase");

-- CreateIndex
CREATE INDEX "AutoTraderPositionSnapshot_symbol_observedAt_idx" ON "AutoTraderPositionSnapshot"("symbol", "observedAt");

-- CreateIndex
CREATE INDEX "AutoTraderTradeLifecycle_accountAddress_network_openedAt_idx" ON "AutoTraderTradeLifecycle"("accountAddress", "network", "openedAt");

-- CreateIndex
CREATE INDEX "AutoTraderTradeLifecycle_symbol_status_openedAt_idx" ON "AutoTraderTradeLifecycle"("symbol", "status", "openedAt");

-- CreateIndex
CREATE INDEX "AutoTraderTradeLifecycle_observedGreenToRed_lateGiveback_idx" ON "AutoTraderTradeLifecycle"("observedGreenToRed", "lateGiveback");

-- CreateIndex
CREATE INDEX "AutoTraderTradeLifecycle_openWasGreenNowRed_openLateGivebac_idx" ON "AutoTraderTradeLifecycle"("openWasGreenNowRed", "openLateGiveback");

-- CreateIndex
CREATE INDEX "AutoTraderTradeLifecycle_closedGreenToRed_closedLateGivebac_idx" ON "AutoTraderTradeLifecycle"("closedGreenToRed", "closedLateGiveback");

-- CreateIndex
CREATE INDEX "AutoTraderTradeLifecycle_runId_idx" ON "AutoTraderTradeLifecycle"("runId");

-- CreateIndex
CREATE INDEX "AutoTraderPositionState_accountAddress_network_symbol_idx" ON "AutoTraderPositionState"("accountAddress", "network", "symbol");

-- CreateIndex
CREATE INDEX "AutoTraderPositionState_lifecycleId_idx" ON "AutoTraderPositionState"("lifecycleId");

-- CreateIndex
CREATE UNIQUE INDEX "AutoTraderPositionState_accountAddress_network_symbol_side__key" ON "AutoTraderPositionState"("accountAddress", "network", "symbol", "side", "openedAt");

-- CreateIndex
CREATE INDEX "AutoTraderPositionManagementEvent_accountAddress_network_cr_idx" ON "AutoTraderPositionManagementEvent"("accountAddress", "network", "createdAt");

-- CreateIndex
CREATE INDEX "AutoTraderPositionManagementEvent_symbol_createdAt_idx" ON "AutoTraderPositionManagementEvent"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "AutoTraderPositionManagementEvent_lifecycleId_idx" ON "AutoTraderPositionManagementEvent"("lifecycleId");

-- CreateIndex
CREATE INDEX "AutoTraderPositionManagementEvent_reasonCode_idx" ON "AutoTraderPositionManagementEvent"("reasonCode");

-- CreateIndex
CREATE INDEX "WalletRiskControl_userAddress_killSwitch_idx" ON "WalletRiskControl"("userAddress", "killSwitch");

-- CreateIndex
CREATE UNIQUE INDEX "WalletRiskControl_userAddress_isTestnet_key" ON "WalletRiskControl"("userAddress", "isTestnet");

-- CreateIndex
CREATE INDEX "UserHyperliquidApiWallet_apiWalletAddress_idx" ON "UserHyperliquidApiWallet"("apiWalletAddress");

-- CreateIndex
CREATE INDEX "UserHyperliquidApiWallet_userAddress_isTestnet_apiWalletAdd_idx" ON "UserHyperliquidApiWallet"("userAddress", "isTestnet", "apiWalletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "UserHyperliquidApiWallet_userAddress_isTestnet_key" ON "UserHyperliquidApiWallet"("userAddress", "isTestnet");

-- CreateIndex
CREATE INDEX "NewsRunContext_ownerAddress_snapshotId_idx" ON "NewsRunContext"("ownerAddress", "snapshotId");

-- CreateIndex
CREATE INDEX "CodexJob_status_priority_notBefore_idx" ON "CodexJob"("status", "priority", "notBefore");

-- CreateIndex
CREATE INDEX "CodexJob_ownerAddress_createdAt_idx" ON "CodexJob"("ownerAddress", "createdAt");

-- CreateIndex
CREATE INDEX "CodexRuntime_leaseUntil_idx" ON "CodexRuntime"("leaseUntil");

-- CreateIndex
CREATE INDEX "DeskPublicCache_expiresAt_idx" ON "DeskPublicCache"("expiresAt");

-- CreateIndex
CREATE INDEX "DeskPublicCache_bookId_fetchedAt_idx" ON "DeskPublicCache"("bookId", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeskPublicCache_bookId_scope_key_key" ON "DeskPublicCache"("bookId", "scope", "key");

-- CreateIndex
CREATE INDEX "DeskBook_ownerAddress_isTestnet_idx" ON "DeskBook"("ownerAddress", "isTestnet");

-- CreateIndex
CREATE UNIQUE INDEX "DeskBook_accountAddress_isTestnet_key" ON "DeskBook"("accountAddress", "isTestnet");

-- CreateIndex
CREATE INDEX "DeskWake_bookId_shiftId_dueAt_idx" ON "DeskWake"("bookId", "shiftId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeskWake_bookId_key_key" ON "DeskWake"("bookId", "key");

-- CreateIndex
CREATE INDEX "DeskShift_bookId_status_createdAt_idx" ON "DeskShift"("bookId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DeskRecord_bookId_kind_id_idx" ON "DeskRecord"("bookId", "kind", "id");

-- CreateIndex
CREATE INDEX "DeskRecord_bookId_shiftId_idx" ON "DeskRecord"("bookId", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "DeskRecord_bookId_key_key" ON "DeskRecord"("bookId", "key");

-- CreateIndex
CREATE INDEX "DeskWatch_bookId_status_deadline_idx" ON "DeskWatch"("bookId", "status", "deadline");

-- CreateIndex
CREATE UNIQUE INDEX "DeskWatch_bookId_key_key" ON "DeskWatch"("bookId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "DeskIntent_cloid_key" ON "DeskIntent"("cloid");

-- CreateIndex
CREATE INDEX "DeskIntent_bookId_state_idx" ON "DeskIntent"("bookId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "DeskIntent_bookId_intentKey_key" ON "DeskIntent"("bookId", "intentKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeskInventory_bookId_instrumentId_key" ON "DeskInventory"("bookId", "instrumentId");

-- CreateIndex
CREATE INDEX "DeskCashFlow_bookId_occurredAt_idx" ON "DeskCashFlow"("bookId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeskCashFlow_bookId_venueKey_key" ON "DeskCashFlow"("bookId", "venueKey");

-- CreateIndex
CREATE INDEX "DeskPair_bookId_state_idx" ON "DeskPair"("bookId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "DeskPair_bookId_intentKey_key" ON "DeskPair"("bookId", "intentKey");

-- CreateIndex
CREATE INDEX "DeskTokenUsage_bookId_model_startedAt_idx" ON "DeskTokenUsage"("bookId", "model", "startedAt");

-- AddForeignKey
ALTER TABLE "LlmDecision" ADD CONSTRAINT "LlmDecision_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "LlmQuery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoTraderRun" ADD CONSTRAINT "AutoTraderRun_llmQueryId_fkey" FOREIGN KEY ("llmQueryId") REFERENCES "LlmQuery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoTraderDecision" ADD CONSTRAINT "AutoTraderDecision_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutoTraderRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoTraderDecision" ADD CONSTRAINT "AutoTraderDecision_positionSnapshotId_fkey" FOREIGN KEY ("positionSnapshotId") REFERENCES "AutoTraderPositionSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoTraderOrderAttempt" ADD CONSTRAINT "AutoTraderOrderAttempt_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutoTraderDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoTraderFill" ADD CONSTRAINT "AutoTraderFill_orderAttemptId_fkey" FOREIGN KEY ("orderAttemptId") REFERENCES "AutoTraderOrderAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoTraderFill" ADD CONSTRAINT "AutoTraderFill_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutoTraderDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoTraderFill" ADD CONSTRAINT "AutoTraderFill_lifecycleId_fkey" FOREIGN KEY ("lifecycleId") REFERENCES "AutoTraderTradeLifecycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoTraderPositionSnapshot" ADD CONSTRAINT "AutoTraderPositionSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutoTraderRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoTraderTradeLifecycle" ADD CONSTRAINT "AutoTraderTradeLifecycle_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutoTraderRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskPublicCache" ADD CONSTRAINT "DeskPublicCache_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "DeskBook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskWake" ADD CONSTRAINT "DeskWake_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "DeskBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskWake" ADD CONSTRAINT "DeskWake_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "DeskShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskShift" ADD CONSTRAINT "DeskShift_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "DeskBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskRecord" ADD CONSTRAINT "DeskRecord_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "DeskBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskWatch" ADD CONSTRAINT "DeskWatch_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "DeskBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

