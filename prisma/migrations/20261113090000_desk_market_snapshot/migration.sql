CREATE TABLE "DeskMarketSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "network" TEXT NOT NULL,
    "asOf" TIMESTAMP NOT NULL,
    "dataJson" TEXT NOT NULL
);
CREATE INDEX "DeskMarketSnapshot_network_asOf_idx" ON "DeskMarketSnapshot"("network", "asOf");
