import {
  compatibleForwardEngine,
  describeRule,
} from "./backtest/rule-definition";
import {
  confirmationDecision,
  comparisonSummary,
  type EntryComparison,
} from "./entry-comparison";
import type { TradeProposal } from "./proposals";
import { listInstruments } from "./instruments";
import { parseDeskMandate } from "./mandate";
import { createHash } from "node:crypto";
import type { DeskBook, PrismaClient } from "@prisma/client";
import {
  historicalCandles,
  historicalFunding,
  candleHistoryCoverage,
} from "./candle-history";
import { candleRuleDirection } from "./rule-signal";
import { simulateCandles, type CandleDataset } from "./backtest/candles";
import {
  ENGINE_VERSION,
  type Rule,
  type ResearchRequest,
  type ResearchContext,
} from "./backtest/types";
import { decodeDeskArtifact } from "./artifacts";
import { journalTransaction } from "./journal";
import { queueWake } from "./books";
import type { DeskTool } from "./runtime";

export type ForwardDecision = {
  instrumentId: string;
  direction: number;
  signalClosedAt: number;
  decidedAt: number;
  entryAt: number;
};
type Study = {
  id: string;
  runId: string;
  engine: string;
  sourceEngine: string;
  rule: Rule;
  request: ResearchRequest;
  context: ResearchContext;
  instrument: CandleDataset[number]["instrument"];
  registeredAt: number;
  startAt: number;
  endAt: number;
  nextCheckAt: number;
  through: number;
  observationDays?: number;
  queuedAt?: number;
  comparison?: EntryComparison;
  status: "queued" | "observing" | "completed" | "blocked_engine_changed";
  decisions: ForwardDecision[];
  data: CandleDataset;
  result?: ReturnType<typeof simulateCandles>;
  lastError?: string;
  missedObservationIntervals: number;
};
const scope = "prospective_rule_simulation_not_orders";
export function prospectiveDecision(
  rule: Rule,
  bars: CandleDataset[number]["bars"],
  step: number,
  now: number,
  registeredAt: number,
  instrumentId: string,
): ForwardDecision | null {
  const closedAt = Math.floor(now / step) * step;
  // A restart never reconstructs missed decisions from later candles. The next
  // model entry is a FUTURE bar open, after this signal was actually observed.
  if (closedAt <= registeredAt || now - closedAt > 90_000) return null;
  const direction = candleRuleDirection(rule, bars, step, closedAt);
  return direction
    ? {
        instrumentId,
        direction,
        signalClosedAt: closedAt,
        decidedAt: now,
        entryAt: closedAt + step,
      }
    : null;
}
export function prospectiveSummary(s: Study) {
  return {
    studyId: s.id,
    runId: s.runId,
    scope: s.comparison ? "paired_entry_timing_simulation" : scope,
    status: s.status,
    modelEngine: s.engine,
    sourceEngine: s.sourceEngine,
    queuedAt: s.queuedAt ? new Date(s.queuedAt).toISOString() : null,
    observationStartsOnAdmission: s.status === "queued",
    instrumentId: s.instrument.id,
    ...(s.comparison
      ? {
          comparison: comparisonSummary(
            s.comparison,
            s.result,
            s.status === "completed",
            s.missedObservationIntervals,
            s.data[0]?.coverage.complete ?? false,
          ),
        }
      : {
          rule: s.rule,
          ruleDefinition: describeRule(s.rule, s.request.intervalSeconds),
        }),
    registeredAt: new Date(s.registeredAt).toISOString(),
    through: new Date(s.through).toISOString(),
    endAt: new Date(s.endAt).toISOString(),
    nextCheckAt: new Date(s.nextCheckAt).toISOString(),
    recordedDecisions: s.decisions.length,
    lastDecisions: s.decisions.slice(-3),
    ...(s.comparison
      ? {
          executionModel: {
            intervalSeconds: s.request.intervalSeconds,
            holdHours: (s.rule.maxHoldBars * s.request.intervalSeconds) / 3600,
            stopBps: s.rule.stopBps,
            targetBps: s.rule.targetBps,
            orderUsd: s.rule.orderUsd,
            feeBpsPerSide: s.request.feeBpsPerSide,
            extraSlippageBps: s.request.extraSlippageBps,
          },
        }
      : {}),
    missedObservationIntervals: s.missedObservationIntervals,
    metrics: s.result?.metrics ?? null,
    dataQuality: s.result?.dataQuality ?? null,
    openModeledPositions: s.result?.endingPositions ?? [],
    lastError: s.lastError ?? null,
    note: "Frozen rule; only timely recorded forward decisions can enter at the following future bar open (one-bar observation delay versus the historical next-open assumption). Modeled stop/target/time exits, fees, slippage and actual settled funding; no account orders or testnet paper trading. Active results may include unrealized P&L. Studies are independent research portfolios, not a combined live allocation.",
  };
}
export function prospectiveTools(db: PrismaClient, book: DeskBook): DeskTool[] {
  return [
    {
      name: "start_prospective_test",
      access: "journal",
      description:
        "Register a frozen variant from one completed single-instrument candle backtest for 2-30 days of read-only forward simulation. Records only signals observed after registration; entries delayed to the following future bar open, stop/target/time exits and costs use the shared backtester. Up to three active studies per book; excess enrollment is durably queued FIFO and automatically starts when a slot frees. Queued time is not observation time. Idempotent per run/variant; no orders, activation or paper trading. Does not require positive historical results, but explain why the mechanism remains worth testing. Completion sends one research review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId", "variantName", "days"],
        properties: {
          runId: { type: "string" },
          variantName: { type: "string" },
          days: { type: "integer", minimum: 2, maximum: 30 },
        },
      },
      run: async (a, c) => {
        const run = await db.deskResearchRun.findFirst({
          where: {
            id: String(a.runId),
            bookId: book.id,
            bookVersion: book.version,
            status: "completed",
          },
        });
        if (!run?.resultArtifactId)
          throw new Error("Select a completed current-book candle experiment.");
        const frozen = JSON.parse(run.requestJson),
          request = frozen.request as ResearchRequest;
        if (request.engine !== "candles" || request.instrumentIds.length !== 1)
          throw new Error(
            "Forward enrollment currently needs a single-instrument candle experiment.",
          );
        const rule = request.variants?.find((r) => r.name === a.variantName),
          days = Number(a.days);
        if (!rule || !Number.isInteger(days) || days < 2 || days > 30)
          throw new Error("Choose a saved variant and 2-30 observation days.");
        const artifact = await db.deskArtifact.findFirst({
          where: { id: run.resultArtifactId, bookId: book.id },
        });
        if (!artifact) throw new Error("Historical result unavailable.");
        if (decodeDeskArtifact(artifact).engine !== "desk-candle-1")
          throw new Error("Select a verified candle result.");
        const shift = await db.deskShift.findFirst({
          where: { id: c.shiftId, bookId: book.id },
        });
        if (!shift) throw new Error("Shift unavailable.");
        const id = createHash("sha256")
            .update(JSON.stringify([book.id, book.version, run.id, rule]))
            .digest("hex")
            .slice(0, 24),
          key = `prospective:${book.version}:${id}`;
        return journalTransaction(db, book, shift, c.signal, async (tx) => {
          await tx.deskBook.updateMany({
            where: { id: book.id, version: book.version },
            data: { updatedAt: new Date() },
          });
          const prior = await tx.deskRecord.findUnique({
            where: { bookId_key: { bookId: book.id, key } },
          });
          if (prior)
            return {
              ...prospectiveSummary(JSON.parse(prior.dataJson)),
              reused: true,
            };
          if (
            !book.enabled ||
            !(await tx.deskBook.count({
              where: { id: book.id, version: book.version, enabled: true },
            }))
          )
            throw new Error(
              "Stopped books do not start background prospective studies.",
            );
          const existing = await tx.deskRecord.findMany({
            where: {
              bookId: book.id,
              kind: "prospective_study",
              key: { startsWith: `prospective:${book.version}:` },
            },
          });
          const queued =
            existing.filter(
              (r) => JSON.parse(r.dataJson).status === "observing",
            ).length >= 3;
          if (
            queued &&
            existing.filter((r) => JSON.parse(r.dataJson).status === "queued")
              .length >= 20
          )
            throw new Error(
              "Twenty studies already queued; resolve existing frozen questions before adding more.",
            );
          const now = Date.now(),
            step = request.intervalSeconds * 1000;
          const study: Study = {
            id,
            runId: run.id,
            engine: ENGINE_VERSION,
            sourceEngine: JSON.parse(run.manifestJson).engine,
            rule,
            request,
            context: frozen.context,
            instrument: frozen.instruments[0],
            registeredAt: now,
            startAt: Math.ceil(now / step) * step,
            endAt: Math.floor((now + days * 86400000) / step) * step,
            nextCheckAt: (Math.floor(now / step) + 1) * step + 5000,
            through: Math.floor(now / step) * step,
            status: queued ? "queued" : "observing",
            observationDays: days,
            ...(queued ? { queuedAt: now } : {}),
            decisions: [],
            data: [],
            missedObservationIntervals: 0,
          };
          await tx.deskRecord.create({
            data: {
              bookId: book.id,
              shiftId: c.shiftId,
              key,
              kind: "prospective_study",
              role: c.role,
              dataJson: JSON.stringify(study),
            },
          });
          return prospectiveSummary(study);
        });
      },
    },
    {
      name: "compare_entry_timing",
      access: "journal",
      description:
        "Freeze a forward comparison for one saved single-perp decisionPlan: enter at the first future bar open versus wait for a specified price/closed-bar confirmation. Same percentage stop/target, holding duration, risk limits and explicit costs. Tests only this stated confirmation, not arbitrary participation/news conditions. Read-only simulation, no backtest prerequisite or orders. Idempotent per proposal revision. Three comparisons can observe concurrently; completion sends one research review. Read results with prospective_tests.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [
          "proposalKey",
          "proposalRevision",
          "intervalSeconds",
          "relation",
          "price",
          "closedBars",
          "maxWaitHours",
          "orderUsd",
          "stopBps",
          "targetBps",
          "feeBpsPerSide",
          "extraSlippageBps",
          "costAssumptions",
        ],
        properties: {
          proposalKey: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9_-]{0,79}$",
          },
          proposalRevision: { type: "integer", minimum: 1 },
          intervalSeconds: { type: "integer", enum: [300, 900, 3600] },
          relation: { type: "string", enum: ["above", "below"] },
          price: { type: "number", exclusiveMinimum: 0 },
          closedBars: { type: "integer", minimum: 1, maximum: 12 },
          maxWaitHours: { type: "number", exclusiveMinimum: 0, maximum: 48 },
          orderUsd: { type: "number", minimum: 10, maximum: 500 },
          stopBps: { type: "number", exclusiveMinimum: 0, maximum: 5000 },
          targetBps: { type: "number", exclusiveMinimum: 0, maximum: 5000 },
          feeBpsPerSide: { type: "number", exclusiveMinimum: 0, maximum: 100 },
          extraSlippageBps: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: 500,
          },
          costAssumptions: { type: "string", minLength: 20, maxLength: 1000 },
        },
      },
      run: async (a, c) => {
        const shift = await db.deskShift.findFirst({
          where: { id: c.shiftId, bookId: book.id },
        });
        if (!shift) throw new Error("Shift unavailable.");
        const proposalKey = String(a.proposalKey);
        const ownKey = `proposal:${book.version}:${shift.mode}:${proposalKey}`;
        const row =
          (await db.deskRecord.findUnique({
            where: { bookId_key: { bookId: book.id, key: ownKey } },
          })) ??
          (shift.mode === "research"
            ? await db.deskRecord.findUnique({
                where: {
                  bookId_key: {
                    bookId: book.id,
                    key: `proposal:${book.version}:live:${proposalKey}`,
                  },
                },
              })
            : null);
        if (!row) throw new Error("Save the candidate and decisionPlan first.");
        const p = JSON.parse(row.dataJson) as TradeProposal;
        if (p.revision !== Number(a.proposalRevision))
          throw new Error(
            "Proposal changed; inspect its decisionPlan before freezing a comparison.",
          );
        const id = createHash("sha256")
          .update(JSON.stringify([book.id, book.version, row.key, p.revision]))
          .digest("hex")
          .slice(0, 24);
        const key = `entry-comparison:${book.version}:${id}`;
        const prior = await db.deskRecord.findUnique({
          where: { bookId_key: { bookId: book.id, key } },
        });
        if (prior)
          return {
            ...prospectiveSummary(JSON.parse(prior.dataJson)),
            reused: true,
          };
        if (
          !p.decisionPlan ||
          p.legs.length !== 1 ||
          p.status === "closed" ||
          Date.parse(p.validUntil) <= Date.now()
        )
          throw new Error(
            "Choose a current single-instrument proposal with a decisionPlan.",
          );
        const instrument = (await listInstruments(book.isTestnet, "perp")).find(
          (i) => i.id === p.legs[0].instrumentId,
        );
        if (!instrument)
          throw new Error(
            "Comparison requires a native perpetual on this book's network.",
          );
        return journalTransaction(db, book, shift, c.signal, async (tx) => {
          if (
            !(
              await tx.deskBook.updateMany({
                where: { id: book.id, version: book.version, enabled: true },
                data: { updatedAt: new Date() },
              })
            ).count
          )
            throw new Error(
              "Stopped books do not start background comparisons.",
            );
          const existing = await tx.deskRecord.findUnique({
            where: { bookId_key: { bookId: book.id, key } },
          });
          if (existing)
            return {
              ...prospectiveSummary(JSON.parse(existing.dataJson)),
              reused: true,
            };
          if (
            !(await tx.deskRecord.count({
              where: { id: row.id, dataJson: row.dataJson },
            }))
          )
            throw new Error(
              "Proposal changed during registration; inspect the new decisionPlan.",
            );
          const active = await tx.deskRecord.count({
            where: {
              bookId: book.id,
              kind: "entry_comparison",
              key: { startsWith: `entry-comparison:${book.version}:` },
              dataJson: { contains: '"status":"observing"' },
            },
          });
          if (active >= 3)
            throw new Error(
              "Three entry comparisons are observing. Their completions own review; retain this question in researchPlan.",
            );
          const now = Date.now(),
            step = Number(a.intervalSeconds) * 1000;
          const entryAt = (Math.floor(now / step) + 1) * step;
          const waitUntil = Math.min(
            now + Number(a.maxWaitHours) * 3600000,
            Date.parse(p.validUntil),
          );
          if (waitUntil < entryAt + Number(a.closedBars) * step)
            throw new Error(
              "Proposal validity and waiting window must allow the requested post-registration closed bars.",
            );
          const rule: Rule = {
            name: "entry-timing",
            signal: "momentum",
            side: p.legs[0].side === "buy" ? "long" : "short",
            lookbackBars: 2,
            thresholdBps: 0,
            orderUsd: Number(a.orderUsd),
            stopBps: Number(a.stopBps),
            targetBps: Number(a.targetBps),
            maxHoldBars: Math.ceil(
              (p.decisionPlan!.horizonHours * 3600000) / step,
            ),
            cooldownBars: 0,
          };
          const endAt =
            (Math.floor(waitUntil / step) + rule.maxHoldBars + 3) * step;
          const request: ResearchRequest = {
            engine: "candles",
            source: "venue_candles",
            hypothesis: p.thesis,
            proposalKey,
            start: new Date(entryAt).toISOString(),
            end: new Date(endAt).toISOString(),
            instrumentIds: [instrument.id],
            intervalSeconds: Number(
              a.intervalSeconds,
            ) as ResearchRequest["intervalSeconds"],
            feeBpsPerSide: Number(a.feeBpsPerSide),
            extraSlippageBps: Number(a.extraSlippageBps),
          };
          const study: Study = {
            id,
            runId: `entry-comparison:${id}`,
            engine: ENGINE_VERSION,
            sourceEngine: ENGINE_VERSION,
            rule,
            request,
            context: {
              bookId: book.id,
              bookVersion: book.version,
              isTestnet: book.isTestnet,
              mandate: parseDeskMandate(book.mandateJson),
            },
            instrument,
            registeredAt: now,
            startAt: entryAt,
            endAt,
            nextCheckAt: entryAt + 5000,
            through: Math.floor(now / step) * step,
            status: "observing",
            decisions: [],
            data: [],
            missedObservationIntervals: 0,
            comparison: {
              proposalKey,
              proposalRevision: p.revision,
              decisionPlan: p.decisionPlan!,
              mode: shift.mode,
              confirmation: {
                relation: a.relation as "above" | "below",
                price: Number(a.price),
                closedBars: Number(a.closedBars),
              },
              waitUntil,
              costAssumptions: String(a.costAssumptions),
              baselineDecisions: [
                {
                  instrumentId: instrument.id,
                  direction: p.legs[0].side === "buy" ? 1 : -1,
                  signalClosedAt: Math.floor(now / step) * step,
                  decidedAt: now,
                  entryAt,
                },
              ],
            },
          };
          await tx.deskRecord.create({
            data: {
              bookId: book.id,
              shiftId: c.shiftId,
              key,
              kind: "entry_comparison",
              role: c.role,
              dataJson: JSON.stringify(study),
            },
          });
          return prospectiveSummary(study);
        });
      },
    },
    {
      name: "prospective_tests",
      access: "read",
      description:
        "Read current-book frozen forward studies, timestamped decisions, modeled results, gaps and open modeled positions. No new market or account requests. A still-running study is not complete evidence; completion wakes review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      run: async () => ({
        scope,
        studies: (
          await db.deskRecord.findMany({
            where: {
              bookId: book.id,
              OR: [
                {
                  kind: "prospective_study",
                  key: { startsWith: `prospective:${book.version}:` },
                },
                {
                  kind: "entry_comparison",
                  key: { startsWith: `entry-comparison:${book.version}:` },
                },
              ],
            },
            orderBy: { createdAt: "desc" },
          })
        ).map((r) => prospectiveSummary(JSON.parse(r.dataJson))),
      }),
    },
  ];
}

/** One due study at a time; price bars only on a new closed interval. Funding
 * is requested only if an already-modeled position crossed a funding boundary. */
export async function observeProspectiveTests(
  db: PrismaClient,
  book: DeskBook,
  now = Date.now(),
) {
  if (!book.enabled) return;
  if (
    await db.deskRecord.count({
      where: {
        bookId: book.id,
        kind: "prospective_study",
        key: { startsWith: `prospective:${book.version}:` },
        dataJson: { contains: '"status":"queued"' },
      },
    })
  )
    await admitQueuedStudies(db, book, now);
  const rows = await db.deskRecord.findMany({
    where: {
      bookId: book.id,
      OR: [
        {
          kind: "prospective_study",
          key: { startsWith: `prospective:${book.version}:` },
        },
        {
          kind: "entry_comparison",
          key: { startsWith: `entry-comparison:${book.version}:` },
        },
      ],
      dataJson: { contains: '"status":"observing"' },
    },
    orderBy: { createdAt: "asc" },
  });
  const due = rows
    .map((row) => ({ row, s: JSON.parse(row.dataJson) as Study }))
    .filter((v) => v.s.status === "observing" && v.s.nextCheckAt <= now)
    .sort((a, b) => a.s.nextCheckAt - b.s.nextCheckAt)[0];
  if (!due) return;
  const { row, s } = due,
    step = s.request.intervalSeconds * 1000,
    through = Math.min(Math.floor(now / step) * step, s.endAt);
  const save = async () =>
    db.deskRecord.updateMany({
      where: { id: row.id, dataJson: row.dataJson },
      data: { dataJson: JSON.stringify(s) },
    });
  if (!compatibleForwardEngine(s.engine, s.rule, ENGINE_VERSION)) {
    s.status = "blocked_engine_changed";
    s.lastError =
      "Simulation engine changed; preserve this frozen study and explicitly register new research.";
    await save();
    return;
  }
  try {
    const warmup = s.comparison
      ? Math.max(s.comparison.confirmation.closedBars + 1, 3) * step
      : Math.max(7 * 86400000, (s.rule.lookbackBars + 2) * step);
    const from = s.data.length ? s.through : s.startAt - warmup;
    const h =
      from < through
        ? await historicalCandles(
            s.instrument.coin,
            s.request.intervalSeconds === 3600
              ? "1h"
              : s.request.intervalSeconds === 900
                ? "15m"
                : "5m",
            from,
            through,
            book.isTestnet,
            AbortSignal.timeout(20000),
          )
        : { bars: [] };
    const prior = s.data[0],
      bars = [
        ...(prior?.bars ?? []),
        ...h.bars.filter((b) => !prior || b.at >= s.through),
      ]
        .filter((b, i, all) => i === 0 || b.at !== all[i - 1].at)
        .sort((a, b) => a.at - b.at);
    s.data = [
      {
        instrument: s.instrument,
        bars,
        funding: prior?.funding ?? [],
        coverage: candleHistoryCoverage(bars, s.startAt, through, step),
        provenance: { scope, firstRegisteredAt: s.registeredAt },
      },
    ];
    s.missedObservationIntervals += Math.max(
      0,
      Math.round((through - s.through) / step) - 1,
    );
    const observedAt = Math.max(now, Date.now());
    if (
      s.comparison && s.decisions.length === 0 && through > s.through &&
      through > s.registeredAt && through <= s.comparison.waitUntil &&
      observedAt - through > 90_000
    ) {
      // A late latest interval is also missed, even when no whole interval was skipped.
      s.missedObservationIntervals++;
    }
    const decision = s.comparison
      ? s.decisions.length
        ? null
        : confirmationDecision(
            s.comparison,
            bars,
            step,
            observedAt,
            s.registeredAt,
            s.instrument.id,
            s.rule.side === "long" ? 1 : -1,
          )
      : prospectiveDecision(
          s.rule,
          bars,
          step,
          observedAt,
          s.registeredAt,
          s.instrument.id,
        );
    if (
      decision &&
      decision.entryAt + s.rule.maxHoldBars * step < s.endAt &&
      !s.decisions.some((d) => d.signalClosedAt === decision.signalClosedAt)
    )
      s.decisions.push(decision);
    s.through = through;
    s.nextCheckAt = through + step + 5000;
    delete s.lastError;
    // Persist the causal decision before downstream funding I/O. Retrying a
    // failed fetch must not invent a decision with an earlier timestamp.
    const committed = JSON.stringify(s);
    if (!(await save()).count) return;
    row.dataJson = committed;
    let result = simulateCandles(
      s.data,
      s.context,
      s.request,
      s.rule,
      s.startAt,
      through,
      1,
      { decisions: s.decisions },
    );
    let baseline = s.comparison
      ? simulateCandles(
          s.data,
          s.context,
          s.request,
          s.rule,
          s.startAt,
          through,
          1,
          { decisions: s.comparison.baselineDecisions },
        )
      : undefined;
    if (
      result.dataQuality.missingFundingWhileExposed ||
      baseline?.dataQuality.missingFundingWhileExposed
    ) {
      const missing = [
        ...result.dataQuality.missingFundingBoundaries,
        ...(baseline?.dataQuality.missingFundingBoundaries ?? []),
      ];
      const rates = await historicalFunding(
        s.instrument.coin,
        Math.min(...missing),
        Math.max(...missing) + 3600000,
        book.isTestnet,
        AbortSignal.timeout(20000),
      );
      s.data[0].funding = [
        ...new Map(
          [...s.data[0].funding, ...rates].map((f) => [f.at, f]),
        ).values(),
      ].sort((a, b) => a.at - b.at);
      result = simulateCandles(
        s.data,
        s.context,
        s.request,
        s.rule,
        s.startAt,
        through,
        1,
        { decisions: s.decisions },
      );
      if (s.comparison)
        baseline = simulateCandles(
          s.data,
          s.context,
          s.request,
          s.rule,
          s.startAt,
          through,
          1,
          { decisions: s.comparison.baselineDecisions },
        );
    }
    s.result = result;
    if (s.comparison) s.comparison.baselineResult = baseline;
    if (through >= s.endAt) s.status = "completed";
    await db.$transaction(async (tx) => {
      if (
        !(await tx.deskBook.count({
          where: { id: book.id, version: book.version, enabled: true },
        }))
      )
        return;
      const won = await tx.deskRecord.updateMany({
        where: { id: row.id, dataJson: row.dataJson },
        data: { dataJson: JSON.stringify(s) },
      });
      if (won.count && s.status === "completed")
        await queueWake(
          tx,
          book,
          "prospective-complete:" + s.id,
          "prospective_complete",
          "research",
          prospectiveSummary(s),
          6,
        );
    });
  } catch (error) {
    s.lastError =
      error instanceof Error
        ? error.message
        : "Prospective observation unavailable";
    s.nextCheckAt = now + 60000;
    await save();
  }
}

/** Serialize admission with enrollment; preserve FIFO and start the clock only now. */
export async function admitQueuedStudies(
  db: PrismaClient,
  book: DeskBook,
  now = Date.now(),
) {
  if (!book.enabled) return;
  await db.$transaction(async (tx) => {
    const locked = await tx.deskBook.updateMany({
      where: { id: book.id, version: book.version, enabled: true },
      data: { updatedAt: new Date() },
    });
    if (!locked.count) return;
    const rows = await tx.deskRecord.findMany({
      where: {
        bookId: book.id,
        kind: "prospective_study",
        key: { startsWith: `prospective:${book.version}:` },
      },
      orderBy: { createdAt: "asc" },
    });
    let slots =
      3 -
      rows.filter((r) => JSON.parse(r.dataJson).status === "observing").length;
    for (const row of rows) {
      if (slots <= 0) break;
      const s = JSON.parse(row.dataJson) as Study;
      if (s.status !== "queued") continue;
      if (!compatibleForwardEngine(s.engine, s.rule, ENGINE_VERSION)) {
        s.status = "blocked_engine_changed";
        s.lastError =
          "Frozen engine changed while queued; explicit new research required.";
      } else {
        const step = s.request.intervalSeconds * 1000;
        s.registeredAt = now;
        s.startAt = Math.ceil(now / step) * step;
        s.endAt =
          Math.floor((now + (s.observationDays ?? 7) * 86400000) / step) * step;
        s.through = Math.floor(now / step) * step;
        s.nextCheckAt = s.through + step + 5000;
        s.status = "observing";
        slots--;
      }
      await tx.deskRecord.update({
        where: { id: row.id },
        data: { dataJson: JSON.stringify(s) },
      });
    }
  });
}
