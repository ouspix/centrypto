ALTER TABLE "CandidateJournal" ADD COLUMN "promotionReason" TEXT;
ALTER TABLE "CandidateJournal" ADD COLUMN "demotionReason" TEXT;
ALTER TABLE "CandidateJournal" ADD COLUMN "matchedPriorBucket" TEXT;
ALTER TABLE "CandidateJournal" ADD COLUMN "configEpoch" DATETIME;

ALTER TABLE "OpportunityJournal" ADD COLUMN "promotionReason" TEXT;
ALTER TABLE "OpportunityJournal" ADD COLUMN "demotionReason" TEXT;
ALTER TABLE "OpportunityJournal" ADD COLUMN "matchedPriorBucket" TEXT;
ALTER TABLE "OpportunityJournal" ADD COLUMN "configEpoch" DATETIME;
ALTER TABLE "OpportunityJournal" ADD COLUMN "pathQuality" TEXT;
ALTER TABLE "OpportunityJournal" ADD COLUMN "policyOutcome" TEXT;

CREATE INDEX "CandidateJournal_configEpoch_idx" ON "CandidateJournal"("configEpoch");
CREATE INDEX "OpportunityJournal_configEpoch_idx" ON "OpportunityJournal"("configEpoch");
CREATE INDEX "OpportunityJournal_pathQuality_createdAt_idx" ON "OpportunityJournal"("pathQuality", "createdAt");
CREATE INDEX "OpportunityJournal_policyOutcome_createdAt_idx" ON "OpportunityJournal"("policyOutcome", "createdAt");
