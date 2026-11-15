import "server-only";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { PrismaClient } from "@prisma/client";

const MAX_BYTES = 16 * 1024 * 1024;
export async function saveDeskArtifact(
  db: PrismaClient,
  bookId: string,
  kind: string,
  value: unknown,
) {
  const json = JSON.stringify(value ?? null),
    bytes = Buffer.byteLength(json);
  if (bytes > MAX_BYTES)
    throw new Error(
      "Evidence artifact exceeds the 16 MB limit; narrow the request.",
    );
  const sha256 = createHash("sha256").update(json).digest("hex");
  const id = createHash("sha256")
    .update(bookId + ":" + kind + ":" + sha256)
    .digest("hex");
  await db.deskArtifact.upsert({
    where: { id },
    update: {},
    create: {
      id,
      bookId,
      kind,
      sha256,
      byteLength: bytes,
      contentJson: gzipSync(json).toString("base64"),
      encoding: "gzip-base64",
    },
  });
  return { artifactId: id, sha256, byteLength: bytes };
}
export function decodeDeskArtifact(row: {
  encoding: string;
  contentJson: string;
  sha256: string;
}) {
  const json =
    row.encoding === "gzip-base64"
      ? gunzipSync(Buffer.from(row.contentJson, "base64"), {
          maxOutputLength: MAX_BYTES,
        }).toString("utf8")
      : row.contentJson;
  if (createHash("sha256").update(json).digest("hex") !== row.sha256)
    throw new Error("Evidence checksum mismatch.");
  return JSON.parse(json);
}
export function journalResult(
  value: unknown,
  artifact: { artifactId: string; sha256: string; byteLength: number },
) {
  const json = JSON.stringify(value ?? null);
  return {
    ...artifact,
    result:
      json.length <= 6000
        ? json
        : JSON.stringify({
            status:
              typeof (value as { status?: unknown })?.status === "string"
                ? (value as { status: string }).status
                : "observed",
            summary: "Full tool result stored in the evidence artifact.",
            ...artifact,
          }),
    resultTruncated: false,
    resultStoredAsArtifact: json.length > 6000,
  };
}
