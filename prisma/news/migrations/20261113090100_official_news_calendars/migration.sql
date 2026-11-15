CREATE TABLE "NewsCalendarRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerAddress" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL
);
CREATE INDEX "NewsCalendarRevision_ownerAddress_source_observedAt_idx"
    ON "NewsCalendarRevision"("ownerAddress", "source", "observedAt");
GRANT SELECT, INSERT, UPDATE, DELETE ON "NewsCalendarRevision" TO centrypto_app, centrypto_browser;
