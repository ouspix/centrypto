import { NextResponse } from "next/server";
import {
  requireWalletSession,
  WalletSessionError,
} from "@/lib/auth/wallet-session";
import { prisma } from "@/lib/db";
import { ownedBook, DeskInputError } from "@/lib/desk/books";
import {
  enqueueResearch,
  researchStatus,
  cancelResearch,
} from "@/lib/desk/backtest/jobs";
import { researchCatalog } from "@/lib/desk/backtest/data";
import { decodeDeskArtifact } from "@/lib/desk/artifacts";
export const dynamic = "force-dynamic";
function failure(e: unknown) {
  return NextResponse.json(
    { error: e instanceof Error ? e.message : "Research unavailable." },
    {
      status:
        e instanceof WalletSessionError || e instanceof DeskInputError
          ? e.status
          : 400,
    },
  );
}
export async function GET(request: Request) {
  try {
    const session = requireWalletSession(request),
      q = new URL(request.url).searchParams;
    const book = await ownedBook(session.address, q.get("bookId"));
    if (q.get("catalog") === "1")
      return NextResponse.json(await researchCatalog(book.isTestnet));
    const artifact = q.get("artifactId");
    if (artifact) {
      const row = await prisma.deskArtifact.findFirst({
        where: { id: artifact, bookId: book.id },
      });
      if (!row) throw new DeskInputError("Evidence not found.", 404);
      return NextResponse.json({
        artifactId: row.id,
        sha256: row.sha256,
        kind: row.kind,
        value: decodeDeskArtifact(row),
      });
    }
    const id = q.get("runId");
    if (id)
      return NextResponse.json(
        await researchStatus(prisma, book.id, id, q.get("full") === "1"),
      );
    const rows = await prisma.deskResearchRun.findMany({
      where: { bookId: book.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        status: true,
        createdAt: true,
        finishedAt: true,
        error: true,
        bookVersion: true,
        isTestnet: true,
        requestJson: true,
      },
    });
    return NextResponse.json({
      runs: rows.map(({ requestJson, ...r }) => ({
        ...r,
        hypothesis: JSON.parse(requestJson).request.hypothesis,
      })),
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    const session = requireWalletSession(request);
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      throw new DeskInputError("Cross-origin research request denied.", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new DeskInputError("JSON required.", 415);
    const text = await request.text();
    if (text.length > 100000)
      throw new DeskInputError("Research request too large.", 413);
    const body = JSON.parse(text),
      book = await ownedBook(session.address, body.bookId);
    if (body.action === "cancel")
      return NextResponse.json(
        await cancelResearch(prisma, book.id, String(body.runId)),
      );
    return NextResponse.json(
      await enqueueResearch(prisma, book, body.request),
      { status: 202 },
    );
  } catch (e) {
    return failure(e);
  }
}
