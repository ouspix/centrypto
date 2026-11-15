CREATE TABLE "OrderLeverageSnapshot" (
    "accountAddress" TEXT NOT NULL,
    "isTestnet" BOOLEAN NOT NULL,
    "cloid" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "oid" TEXT,
    "leverage" INTEGER NOT NULL,
    "marginMode" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderLeverageSnapshot_pkey" PRIMARY KEY ("accountAddress", "isTestnet", "cloid")
);

CREATE INDEX "OrderLeverageSnapshot_accountAddress_isTestnet_coin_oid_idx"
ON "OrderLeverageSnapshot"("accountAddress", "isTestnet", "coin", "oid");
