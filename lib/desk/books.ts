import { EXECUTABLE_STRATEGIES } from "./decision-policy";
import "server-only";
import { assertNewsStrategyExecutable, NEWS_STRATEGY_VERSION } from "./news-strategy";
import { randomUUID } from "crypto";
import type { DeskBook, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hyperliquidInfoUrl } from "@/lib/hyperliquid-info";
import { getHyperliquidApiWalletStatus } from "@/lib/hyperliquid-api-wallet";
import { parseDeskMandate, DIRECTIONAL_HOST_LIMITS } from "./mandate";
import { withAccountExecutionLease } from "./execution-lease";

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
    return withAccountExecutionLease(prisma, book.ownerAddress, book.isTestnet, async (check) => {
      await check();
      return prisma.$transaction(async (tx) => {
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
    });
}

export type DeskMode = "live" | "research";
/** Owner-only API operation. Agents have no tool that can change strategy rollout. */
export async function setStrategyState(book:DeskBook,data:Record<string,unknown>){
    if(data.version!==book.version)throw new DeskInputError("Book changed. Refresh and try again.",409);
    if (data.strategyVersion === NEWS_STRATEGY_VERSION) {
        try { assertNewsStrategyExecutable(NEWS_STRATEGY_VERSION, false); }
        catch (error) { throw new DeskInputError((error as Error).message); }
    }
    if(!EXECUTABLE_STRATEGIES.includes(data.strategyVersion as typeof EXECUTABLE_STRATEGIES[number])||!["research_only","active"].includes(String(data.state)))throw new DeskInputError("Choose a supported strategy state.");
    const mandate=parseDeskMandate(book.mandateJson);
    if(book.kind!=="directional"||!mandate.maxOpenRiskUsd||!mandate.maxConcurrentPositions||!mandate.costAllowanceBps||mandate.capitalUsd>DIRECTIONAL_HOST_LIMITS.capitalUsd)throw new DeskInputError(`Install directional risk controls within the ${DIRECTIONAL_HOST_LIMITS.capitalUsd} USDC capital ceiling first.`);
    return withAccountExecutionLease(prisma,book.ownerAddress,book.isTestnet,async check=>{
        await check();
        return prisma.$transaction(async tx=>{
            const current=await tx.deskBook.findUniqueOrThrow({where:{id:book.id}});
            if(current.version!==book.version)throw new DeskInputError("Book changed. Refresh and try again.",409);
            const key=`strategy-rollout:${data.strategyVersion}`,value={version:data.strategyVersion,state:data.state,changedAt:new Date().toISOString(),capitalCeilingUsd:DIRECTIONAL_HOST_LIMITS.capitalUsd,bookVersion:book.version};
            await tx.deskRecord.upsert({where:{bookId_key:{bookId:book.id,key}},create:{bookId:book.id,key,kind:"strategy_rollout",role:"operator",dataJson:JSON.stringify(value)},update:{dataJson:JSON.stringify(value),createdAt:new Date()}});
            if(data.state==="active")for(const other of EXECUTABLE_STRATEGIES.filter(v=>v!==data.strategyVersion)){
                const old=await tx.deskRecord.findUnique({where:{bookId_key:{bookId:book.id,key:`strategy-rollout:${other}`}}});
                if(old && JSON.parse(old.dataJson).state==="active"){
                    const retired={...JSON.parse(old.dataJson),state:"research_only",changedAt:value.changedAt,supersededBy:data.strategyVersion};
                    await tx.deskRecord.update({where:{id:old.id},data:{dataJson:JSON.stringify(retired),createdAt:new Date()}});
                    await record(tx,book.id,null,randomUUID(),"strategy_authority","operator",retired);
                }
            }
            await record(tx,book.id,null,randomUUID(),"strategy_authority","operator",value);
            return value; // Does not enable the book or change testnet/paper status.
        });
    });
}
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
