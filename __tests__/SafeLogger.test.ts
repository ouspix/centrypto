import { describe, expect, it } from "vitest";
import { redactSensitive } from "@/lib/log/safeLogger";

describe("safe logger redaction", () => {
    it("redacts secrets, signatures, bearer tokens, and wallet addresses", () => {
        const redacted = redactSensitive({
            signature: "0x" + "a".repeat(130),
            authorization: "Bearer secret-token",
            wallet: "0x1234567890123456789012345678901234567890",
            nested: {
                privateKey: "0x" + "b".repeat(64)
            }
        });

        expect(JSON.stringify(redacted)).not.toContain("secret-token");
        expect(JSON.stringify(redacted)).not.toContain("1234567890123456789012345678901234567890");
        expect((redacted as any).signature).toBe("[redacted]");
        expect((redacted as any).nested.privateKey).toBe("[redacted]");
    });
});
