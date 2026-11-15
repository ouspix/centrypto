import "server-only";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
export async function withAccountExecutionLease<T>(
  db: PrismaClient,
  owner: string,
  testnet: boolean,
  work: (assertLease: () => Promise<void>) => Promise<T>,
) {
  const key = owner.toLowerCase() + ":" + testnet,
    token = randomUUID();
  await db.deskExecutionLease.upsert({
    where: { key },
    create: { key, token: "", expiresAt: new Date(0) },
    update: {},
  });
  const claimed = await db.deskExecutionLease.updateMany({
    where: { key, expiresAt: { lt: new Date() } },
    data: { token, expiresAt: new Date(Date.now() + 60000) },
  });
  if (!claimed.count)
    throw new Error(
      "Account execution is busy. Retry after the current operation completes.",
    );
  const check = async () => {
    const current = await db.deskExecutionLease.findUnique({ where: { key } });
    if (current?.token !== token || +current.expiresAt <= Date.now())
      throw new Error("Account execution lease lost.");
  };
  const timer = setInterval(() => {
    void db.deskExecutionLease
      .updateMany({
        where: { key, token },
        data: { expiresAt: new Date(Date.now() + 60000) },
      })
      .catch(() => {});
  }, 15000);
  timer.unref?.();
  try {
    return await work(check);
  } finally {
    clearInterval(timer);
    await db.deskExecutionLease.updateMany({
      where: { key, token },
      data: { token: "", expiresAt: new Date(0) },
    });
  }
}
export async function withManualExecution<T>(
  db: PrismaClient,
  owner: string,
  testnet: boolean,
  cleanup: boolean,
  work: (check: () => Promise<void>) => Promise<T>,
) {
  return withAccountExecutionLease(db, owner, testnet, async (check) => {
    const book = await db.deskBook.findUnique({
      where: {
        accountAddress_isTestnet: {
          accountAddress: owner.toLowerCase(),
          isTestnet: testnet,
        },
      },
    });
    if (book) {
      const inventory = await db.deskInventory.count({
        where: { bookId: book.id, quantity: { not: 0 } },
      });
      const intents = await db.deskIntent.count({
        where: {
          bookId: book.id,
          state: {
            in: ["submitting", "unknown", "working", "settling", "blocked"],
          },
        },
      });
      if (!cleanup && (book.enabled || inventory || intents))
        throw new Error(
          "This account is managed by the desk. Stop and reconcile its positions/orders before opening a manual trade.",
        );
      if (cleanup && (book.enabled || inventory || intents))
        await db.$transaction(async (tx) => {
          await tx.deskBook.update({
            where: { id: book.id },
            data: {
              enabled: false,
              version: { increment: 1 },
              lastError:
                "Manual emergency action: reconcile and hand over inventory before resuming.",
            },
          });
          await tx.deskInventory.updateMany({
            where: { bookId: book.id },
            data: { suspended: true },
          });
          await tx.deskRecord.create({
            data: {
              bookId: book.id,
              key: randomUUID(),
              kind: "manual_handover",
              role: "operator",
              dataJson: JSON.stringify({
                reason:
                  "Manual reduce/cancel paused autonomous authority and suspended inventory ownership.",
              }),
            },
          });
        });
    }
    await check();
    return { value: await work(check), deskPaused: !!(book && cleanup) };
  });
}
