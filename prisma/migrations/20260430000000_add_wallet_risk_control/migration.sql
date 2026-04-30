-- CreateTable
CREATE TABLE "WalletRiskControl" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userAddress" TEXT NOT NULL,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletRiskControl_userAddress_isTestnet_key" ON "WalletRiskControl"("userAddress", "isTestnet");

-- CreateIndex
CREATE INDEX "WalletRiskControl_userAddress_killSwitch_idx" ON "WalletRiskControl"("userAddress", "killSwitch");
