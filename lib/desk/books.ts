import "server-only";
import { randomUUID } from "crypto";
import type { DeskBook, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import { getHyperliquidApiWalletStatus } from "@/lib/hyperliquid-api-wallet";
import { parseDeskMandate } from "./mandate";

export class DeskInputError extends Error {
    constructor(
        message: string,
        public status = 400,
    ) {
        super(message);
    }
}

export async function ownedBook(ownerAddress: string, id: unknown) {
    if (typeof id !== "string" || id.length > 100) throw new DeskInputError("Select a desk book.");
    const book = await prisma.deskBook.findFirst({ where: { id, ownerAddress } });
    if (!book) throw new DeskInputError("Book not found.", 404);
    return book;
}

async function verifyAccount(owner: string, account: string, kind: string, testnet: boolean) {
    if (kind === "directional" && owner === account) return;
    if (account === owner) throw new DeskInputError("Quoting requires a dedicated subaccount.");
    const response = await fetch(hyperliquidInfoUrl(testnet), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "subAccounts", user: owner }),
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
    });
    if (!response.ok) throw new DeskInputError("Subaccount verification unavailable.", 503);
    const subs: unknown = await response.json();
    if (
        !Array.isArray(subs) ||
        !subs.some((s) => typeof s?.subAccountUser === "string" && s.subAccountUser.toLowerCase() === account)
    ) {
        throw new DeskInputError("This subaccount does not belong to the connected wallet.");
    }
}

export async function addBook(owner: string, data: Record<string, unknown>) {
    const account = typeof data.accountAddress === "string" ? data.accountAddress.toLowerCase() : "";
    if (
        !/^0x[0-9a-f]{40}$/.test(account) ||
        typeof data.isTestnet !== "boolean" ||
        !["quoting", "directional"].includes(String(data.kind))
    ) {
        throw new DeskInputError("Choose a valid account, network, and book type.");
    }
    await verifyAccount(owner, account, String(data.kind), data.isTestnet);
    return prisma.deskBook.create({
        data: {
            ownerAddress: owner,
            accountAddress: account,
            isTestnet: data.isTestnet,
            kind: String(data.kind),
            mandateJson: JSON.stringify(parseDeskMandate(data.mandate)),
        },
    });
}

export async function updateBook(book: DeskBook, data: Record<string, unknown>) {
    if (data.version !== book.version) throw new DeskInputError("Book changed. Refresh and try again.", 409);
    const disabling = data.enabled === false;
    if (data.enabled !== undefined && typeof data.enabled !== "boolean")
        throw new DeskInputError("Invalid enabled setting.");
    const frequency = data.frequencySeconds ?? book.frequencySeconds;
    if (!Number.isInteger(frequency) || Number(frequency) < 60 || Number(frequency) > 86400)
        throw new DeskInputError("Review interval must be 60–86,400 seconds.");
    const enabled = disabling ? false : data.enabled === true || book.enabled;
    const mandate = parseDeskMandate(data.mandate ?? JSON.parse(book.mandateJson));
    if (enabled && !book.enabled) {
        await verifyAccount(book.ownerAddress, book.accountAddress, book.kind, book.isTestnet);
        if (!(await getHyperliquidApiWalletStatus(book.ownerAddress, book.isTestnet)).configured)
            throw new DeskInputError("Configure the delegated trading wallet first.");
    }
    return prisma.$transaction(async (tx) => {
        if (enabled) {
            const active = await tx.autoTraderSettings.findFirst({
                where: {
                    userAddress: { in: [book.accountAddress, book.ownerAddress] },
                    isTestnet: book.isTestnet,
                    enabled: true,
                },
            });
            const running = await tx.autoTraderRun.findFirst({
                where: {
                    accountAddress: { in: [book.accountAddress, book.ownerAddress] },
                    network: book.isTestnet ? "testnet" : "mainnet",
                    status: "RUNNING",
                },
            });
            if (active || running)
                throw new DeskInputError(
                    "Stop the existing auto-trader and wait for its current cycle to finish.",
                    409,
                );
        }
        const result = await tx.deskBook.updateMany({
            where: { id: book.id, version: book.version },
            data: {
                enabled,
                mandateJson: JSON.stringify(mandate),
                frequencySeconds: Number(frequency),
                version: { increment: 1 },
                nextReviewAt: new Date(),
            },
        });
        if (!result.count) throw new DeskInputError("Book changed. Refresh and try again.", 409);
        await tx.deskRecord.create({
            data: {
                bookId: book.id,
                key: randomUUID(),
                kind: "mandate",
                role: "operator",
                dataJson: JSON.stringify({ version: book.version + 1, mandate, enabled, frequencySeconds: frequency }),
            },
        });
        return tx.deskBook.findUniqueOrThrow({ where: { id: book.id } });
    });
}

export type DeskMode = "live" | "research";
export function queueWake(
    tx: Prisma.TransactionClient,
    book: DeskBook,
    key: string,
    kind: string,
    mode: DeskMode,
    payload: unknown,
    priority = 5,
    dueAt = new Date(),
    expiresAt: Date | null = null,
) {
    return tx.deskWake.upsert({
        where: { bookId_key: { bookId: book.id, key } },
        update: {},
        create: {
            bookId: book.id,
            key,
            kind,
            mode,
            version: book.version,
            priority,
            payload: JSON.stringify(payload),
            dueAt,
            expiresAt,
        },
    });
}

export function record(
    tx: Prisma.TransactionClient,
    bookId: string,
    shiftId: string | null,
    key: string,
    kind: string,
    role: string,
    data: unknown,
) {
    return tx.deskRecord.upsert({
        where: { bookId_key: { bookId, key } },
        update: {},
        create: { bookId, shiftId, key, kind, role, dataJson: JSON.stringify(data) ?? "null" },
    });
}

export async function operatorMessage(book: DeskBook, data: Record<string, unknown>) {
    const message = typeof data.message === "string" ? data.message.trim() : "";
    if (!message || message.length > 4000 || !["research", "instruction"].includes(String(data.kind)))
        throw new DeskInputError("Enter a message of up to 4,000 characters.");
    const mode = data.kind === "instruction" ? "live" : "research";
    if (mode === "live" && !book.enabled)
        throw new DeskInputError("Enable the book before giving a trading instruction.");
    if (typeof data.requestId !== "string" || !/^[\da-f-]{36}$/i.test(data.requestId))
        throw new DeskInputError("Invalid message ID.");
    const key = "operator:" + data.requestId;
    return prisma.$transaction(async (tx) => {
        await record(tx, book.id, null, key, "message", "operator", { message, mode });
        return queueWake(
            tx,
            book,
            key,
            "operator",
            mode,
            { message },
            8,
            new Date(),
            mode === "live" ? new Date(Date.now() + book.frequencySeconds * 1000) : null,
        );
    });
}
