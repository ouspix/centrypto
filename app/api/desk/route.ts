import { deskChat } from "@/lib/desk/chat";
import { currentDecisionPolicy } from "@/lib/desk/decision-policy";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { prisma } from "@/lib/db";
import { addBook, ownedBook, updateBook, setStrategyState, operatorMessage, DeskInputError, record } from "@/lib/desk/books";
import { abandonDeskIntent, adoptDeskPosition, deskExecutionState } from "@/lib/desk/execution";
import { getWalletKillSwitch, setWalletKillSwitch } from "@/lib/risk/kill-switch";
import { listInstruments } from "@/lib/desk/instruments";
import { parseDeskMandate } from "@/lib/desk/mandate";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
const respond = (value: unknown, status = 200) =>
    NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
function failure(error: unknown) {
    if (error instanceof WalletSessionError || error instanceof DeskInputError)
        return respond({ error: error.message }, error.status);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002") return respond({ error: "This account already has a book on this network." }, 409);
        if (error.code === "P2021")
            return respond({ error: "Install the desk database migrations before using this feature." }, 503);
    }
    console.error("[Desk API]", error instanceof Error ? error.name : "unavailable");
    return respond({ error: "Desk operation failed. Check the local worker and exchange connection." }, 503);
}

export async function GET(request: Request) {
    try {
        const { address } = requireWalletSession(request),
            url = new URL(request.url);
        const network = url.searchParams.get("network");
        if (network !== "mainnet" && network !== "testnet") throw new DeskInputError("Choose a network.");
        const isTestnet = network === "testnet";
        const books = await prisma.deskBook.findMany({
            where: { ownerAddress: address, isTestnet },
            orderBy: { createdAt: "asc" },
        });
        const id = url.searchParams.get("bookId");
        const book = id ? books.find((b) => b.id === id) : books[0];
        if (id && !book) throw new DeskInputError("Book not found.", 404);
        const query = url.searchParams.get("instruments");
        if (query !== null) {
            if (!book) throw new DeskInputError("Book not found.", 404);
            const q = query.trim().toLowerCase().slice(0, 100);
            const rows = q
                ? (await listInstruments(isTestnet))
                      .filter((i) => [i.base, i.id, i.coin].some((s) => s.toLowerCase().includes(q)))
                      .slice(0, 30)
                : [];
            return respond({
                instruments: rows.map(({ id, base, quote, coin, kind }) => ({ id, base, quote, coin, kind })),
            });
        }
        const killSwitch = await getWalletKillSwitch(address, isTestnet);
        if (!book)
            return respond({ books, book: null, state: null, watches: [], records: [], shifts: [], killSwitch });
        const [state, records, watches, shifts, strategyRollout, chat] = await Promise.all([
            deskExecutionState(book.id),
            prisma.deskRecord.findMany({
                where: { bookId: book.id, kind: { notIn: ["market_sample", "opportunity_scan", "opportunity_state", "review_triage_state"] } },
                orderBy: { id: "desc" },
                take: 150,
            }),
            prisma.deskWatch.findMany({ where: { bookId: book.id }, orderBy: { createdAt: "desc" }, take: 100 }),
            prisma.deskShift.findMany({
                where: { bookId: book.id },
                orderBy: { createdAt: "desc" },
                take: 16,
                select: {
                    id: true,
                    mode: true,
                    status: true,
                    attempts: true,
                    briefJson: true,
                    error: true,
                    createdAt: true,
                    endedAt: true,
                },
            }),
            currentDecisionPolicy(prisma,book),
            deskChat(book.id, book.version),
        ]);
        return respond({ books, book, state, records, watches, shifts, killSwitch, chat, strategy:JSON.parse(book.mandateJson).maxOpenRiskUsd?strategyRollout.rollout:null });
    } catch (e) {
        return failure(e);
    }
}

export async function POST(request: Request) {
    try {
        const { address } = requireWalletSession(request);
        const origin = request.headers.get("origin");
        const url = new URL(request.url);
        // Next reconstructs request.url with the server bind address. The Host
        // header retains the browser-facing authority (including its port).
        const expectedOrigin = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin;
        if (origin && origin !== expectedOrigin)
            throw new DeskInputError("Cross-origin desk request denied.", 403);
        if (!request.headers.get("content-type")?.startsWith("application/json"))
            throw new DeskInputError("JSON required.", 415);
        const data = await request.json().catch(() => null);
        if (!data || Array.isArray(data) || typeof data !== "object")
            throw new DeskInputError("Invalid desk operation.");
        if (data.mandate !== undefined) {
            try {
                parseDeskMandate(data.mandate);
            } catch (e) {
                throw new DeskInputError(e instanceof Error ? e.message : "Invalid mandate.");
            }
        }
        if (data.action === "create") {
            const book = await addBook(address, data);
            return respond({ ok: true, bookId: book.id }, 201);
        }
        const book = await ownedBook(address, data.bookId);
        switch (data.action) {
            case "strategy_state":
                await setStrategyState(book,data);
                break;
            case "configure":
                await updateBook(book, data);
                break;
            case "message":
                await operatorMessage(book, data);
                break;
            case "handover": {
                if (typeof data.instrumentId !== "string" || data.instrumentId.length > 180)
                    throw new DeskInputError("Choose a resolved instrument.");
                await adoptDeskPosition(book.id, data.instrumentId);
                await record(prisma, book.id, null, randomUUID(), "handover", "operator", {
                    instrumentId: data.instrumentId,
                });
                break;
            }
            case "reconcile_unknown": {
                if (typeof data.intentId !== "string") throw new DeskInputError("Select an unresolved desk intent.");
                await abandonDeskIntent(book.id, data.intentId);
                await record(prisma, book.id, null, randomUUID(), "reconcile_unknown", "operator", {
                    intentId: data.intentId,
                });
                break;
            }
            case "kill": {
                if (typeof data.enabled !== "boolean") throw new DeskInputError("Choose a kill-switch state.");
                await setWalletKillSwitch(address, book.isTestnet, data.enabled);
                await record(prisma, book.id, null, randomUUID(), "kill_switch", "operator", {
                    enabled: data.enabled,
                });
                break;
            }
            default:
                throw new DeskInputError("Unknown desk operation.");
        }
        return respond({ ok: true, bookId: book.id });
    } catch (e) {
        return failure(e);
    }
}
