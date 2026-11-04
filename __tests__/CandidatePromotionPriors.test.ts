import { describe, expect, it } from "vitest";
import {
    readCandidatePromotionPriorBuckets,
    validateLivePriorBuckets
} from "@/lib/candidate-promotion-priors";

describe("candidate promotion prior buckets", () => {
    it("parses rolling_prior.csv and joins saved statuses", async () => {
        const plain = await readCandidatePromotionPriorBuckets();
        const positive = plain.find(bucket => bucket.positive);
        expect(positive).toBeDefined();

        const buckets = await readCandidatePromotionPriorBuckets({
            prior_buckets: {
                [positive!.key]: { status: "LIVE" }
            }
        });
        const updated = buckets.find(bucket => bucket.key === positive!.key);

        expect(updated).toMatchObject({
            key: positive!.key,
            playbook: positive!.playbook,
            status: "LIVE",
            positive: true
        });
        expect(updated!.episodes).toBeGreaterThan(0);
    });

    it("rejects LIVE prior buckets that are not positive in rolling_prior.csv", async () => {
        const buckets = await readCandidatePromotionPriorBuckets();
        const positive = buckets.find(bucket => bucket.positive);
        const nonPositive = buckets.find(bucket => !bucket.positive);
        expect(positive).toBeDefined();
        expect(nonPositive).toBeDefined();

        await expect(validateLivePriorBuckets({
            prior_buckets: {
                [positive!.key]: { status: "LIVE" }
            }
        })).resolves.toBeUndefined();
        await expect(validateLivePriorBuckets({
            prior_buckets: {
                [nonPositive!.key]: { status: "LIVE" }
            }
        })).rejects.toThrow("LIVE prior buckets must be positive");
    });
});
