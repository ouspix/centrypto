CREATE TABLE "NewsEventRevision" (
    "id" SERIAL PRIMARY KEY,
    "ownerAddress" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "material" BOOLEAN NOT NULL,
    "detailsJson" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "NewsEventRevision_ownerAddress_analysisId_eventKey_key" ON "NewsEventRevision"("ownerAddress","analysisId","eventKey");
CREATE INDEX "NewsEventRevision_ownerAddress_eventKey_id_idx" ON "NewsEventRevision"("ownerAddress","eventKey","id");
CREATE INDEX "NewsEventRevision_ownerAddress_material_id_idx" ON "NewsEventRevision"("ownerAddress","material","id");

-- The deployment's app user and the migration user are distinct.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'centrypto_app') THEN
        GRANT SELECT, INSERT, DELETE ON "NewsEventRevision" TO centrypto_app;
        GRANT USAGE, SELECT ON SEQUENCE "NewsEventRevision_id_seq" TO centrypto_app;
    END IF;
END
$$;
