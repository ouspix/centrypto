// @vitest-environment node
import { it, expect } from "vitest";
import {
  saveDeskArtifact,
  decodeDeskArtifact,
  journalResult,
} from "@/lib/desk/artifacts";
it("preserves large evidence exactly while the journal remains valid JSON", async () => {
  const rows = new Map<string, any>(),
    db = {
      deskArtifact: {
        upsert: async ({ create }: any) => {
          rows.set(create.id, create);
          return create;
        },
      },
    } as any;
  const value = {
    status: "observed",
    evidence: "x".repeat(12000),
    availableAt: "2026-11-06T12:00:00Z",
  };
  const ref = await saveDeskArtifact(db, "owner-book", "tool_result", value),
    journal = journalResult(value, ref);
  expect(() => JSON.parse(journal.result)).not.toThrow();
  expect(journal.resultTruncated).toBe(false);
  expect(decodeDeskArtifact(rows.get(ref.artifactId))).toEqual(value);
  const other = await saveDeskArtifact(
    db,
    "different-book",
    "tool_result",
    value,
  );
  expect(other.artifactId).not.toBe(ref.artifactId);
  rows.get(ref.artifactId).sha256 = "wrong";
  expect(() => decodeDeskArtifact(rows.get(ref.artifactId))).toThrow(
    /checksum/,
  );
});
