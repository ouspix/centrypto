-- Store one encrypted Hyperliquid API-wallet credential per authenticated user wallet and network.
CREATE TABLE "UserHyperliquidApiWallet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userAddress" TEXT NOT NULL,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,
    "apiWalletAddress" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL DEFAULT 'v1',
    "lastVerifiedAt" DATETIME,
    "delegationValidUntil" DATETIME,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "UserHyperliquidApiWallet_userAddress_isTestnet_key"
    ON "UserHyperliquidApiWallet"("userAddress", "isTestnet");

CREATE INDEX "UserHyperliquidApiWallet_apiWalletAddress_idx"
    ON "UserHyperliquidApiWallet"("apiWalletAddress");

CREATE INDEX "UserHyperliquidApiWallet_userAddress_isTestnet_apiWalletAddress_idx"
    ON "UserHyperliquidApiWallet"("userAddress", "isTestnet", "apiWalletAddress");
