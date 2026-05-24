CREATE TABLE "AutoTraderSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userAddress" TEXT NOT NULL,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequencySeconds" INTEGER NOT NULL DEFAULT 600,
    "model" TEXT NOT NULL,
    "config" TEXT,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "AutoTraderSettings_userAddress_isTestnet_key" ON "AutoTraderSettings"("userAddress", "isTestnet");
CREATE INDEX "AutoTraderSettings_enabled_nextRunAt_idx" ON "AutoTraderSettings"("enabled", "nextRunAt");
CREATE INDEX "AutoTraderSettings_userAddress_enabled_idx" ON "AutoTraderSettings"("userAddress", "enabled");
