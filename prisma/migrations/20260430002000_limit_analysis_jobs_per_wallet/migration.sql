UPDATE "AnalysisJob"
SET "status" = 'cancelled', "completedAt" = CURRENT_TIMESTAMP
WHERE "userAddress" IS NOT NULL
  AND "status" = 'running'
  AND "id" NOT IN (
    SELECT keep."id"
    FROM "AnalysisJob" AS keep
    WHERE keep."userAddress" = "AnalysisJob"."userAddress"
      AND keep."status" = 'running'
    ORDER BY keep."createdAt" DESC
    LIMIT 1
  );

UPDATE "AnalysisJob"
SET "status" = 'cancelled', "completedAt" = CURRENT_TIMESTAMP
WHERE "userAddress" IS NOT NULL
  AND "status" = 'pending'
  AND "id" NOT IN (
    SELECT keep."id"
    FROM "AnalysisJob" AS keep
    WHERE keep."userAddress" = "AnalysisJob"."userAddress"
      AND keep."status" = 'pending'
    ORDER BY keep."createdAt" ASC
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS "AnalysisJob_one_running_per_wallet"
ON "AnalysisJob"("userAddress")
WHERE "userAddress" IS NOT NULL AND "status" = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS "AnalysisJob_one_pending_per_wallet"
ON "AnalysisJob"("userAddress")
WHERE "userAddress" IS NOT NULL AND "status" = 'pending';
