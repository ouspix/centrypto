"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useTrading } from "@/context/TradingContext";
import type { Rule } from "@/lib/desk/backtest/types";

const initialRule: Rule = {
  name: "Trend pullback continuation",
  signal: "trend_pullback",
  side: "both",
  lookbackBars: 20,
  thresholdBps: 10,
  orderUsd: 250,
  stopBps: 150,
  targetBps: 300,
  maxHoldBars: 24,
  cooldownBars: 5,
};
const numericLabels: Record<string, string> = {
  lookbackBars: "Lookback bars",
  thresholdBps: "Signal threshold (bps)",
  orderUsd: "Order size (USD)",
  stopBps: "Stop distance (bps)",
  targetBps: "Target distance (bps)",
  maxHoldBars: "Maximum holding bars",
  cooldownBars: "Cooldown bars",
};
const inputStyle =
  "rounded border border-slate-700 bg-slate-950 p-2 text-slate-100";
const localDate = (date: Date) =>
  new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function ResearchSession({
  owner,
  testnet,
}: {
  owner: string;
  testnet: boolean;
}) {
  const [books, setBooks] = useState<any[]>([]),
    [bookId, setBookId] = useState(""),
    [error, setError] = useState("");
  const [runs, setRuns] = useState<any[]>([]),
    [selected, setSelected] = useState(""),
    [result, setResult] = useState<any>(null);
  const [catalog, setCatalog] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [hypothesis, setHypothesis] = useState("");
  const [source, setSource] = useState("venue_candles"),
    [symbols, setSymbols] = useState("BTC"),
    [interval, setIntervalSeconds] = useState(3600);
  const [start, setStart] = useState(() =>
      localDate(new Date(Date.now() - 90 * 86400000)),
    ),
    [end, setEnd] = useState(() =>
      localDate(new Date(Math.floor(Date.now() / 60000) * 60000)),
    );
  const [fee, setFee] = useState(4.5),
    [slippage, setSlippage] = useState(3),
    [rule, setRule] = useState<Rule>(initialRule),
    [variants, setVariants] = useState<Rule[]>([]);
  useEffect(() => {
    const c = new AbortController();
    void fetch("/api/desk?network=" + (testnet ? "testnet" : "mainnet"), {
      signal: c.signal,
      cache: "no-store",
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        if (c.signal.aborted) return;
        const owned = (d.books ?? []).filter(
          (b: any) => b.ownerAddress === owner && b.isTestnet === testnet,
        );
        setBooks(owned);
        setBookId(owned[0]?.id ?? "");
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [owner, testnet]);
  useEffect(() => {
    setRuns([]);
    setSelected("");
    setResult(null);
    setCatalog(null);
    if (!bookId) return;
    const c = new AbortController();
    const read = async () => {
      try {
        const r = await fetch(
            "/api/backtest/run?" + new URLSearchParams({ bookId }),
            { signal: c.signal, cache: "no-store" },
          ),
          d = await r.json();
        if (!r.ok) throw new Error(d.error);
        if (!c.signal.aborted) setRuns(d.runs);
      } catch (e) {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : "Research unavailable.");
      }
    };
    void read();
    const timer = setInterval(read, 5000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [bookId]);
  useEffect(() => {
    setResult(null);
    if (!bookId || !selected) return;
    const c = new AbortController();
    const read = async () => {
      try {
        const r = await fetch(
            "/api/backtest/run?" +
              new URLSearchParams({ bookId, runId: selected }),
            { signal: c.signal, cache: "no-store" },
          ),
          d = await r.json();
        if (!r.ok) throw new Error(d.error);
        if (!c.signal.aborted) setResult(d);
      } catch (e) {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : "Result unavailable.");
      }
    };
    void read();
    const timer = setInterval(read, 5000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [bookId, selected]);
  const book = books.find((b) => b.id === bookId);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const request = {
        hypothesis,
        engine:source === "venue_candles" ? "candles" : "depth",
        source,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        instrumentIds: symbols
          .split(",")
          .map((s) => (testnet ? "testnet" : "mainnet") + ":perp:" + s.trim())
          .filter((s) => !s.endsWith(":")),
        intervalSeconds: interval,
        feeBpsPerSide: fee,
        extraSlippageBps: slippage,
        variants: variants.length ? variants : [rule],
      };
      const r = await fetch("/api/backtest/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookId, request }),
        }),
        d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setSelected(d.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not queue research.");
    } finally {
      setBusy(false);
    }
  }
  async function loadCatalog() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(
          "/api/backtest/run?" + new URLSearchParams({ bookId, catalog: "1" }),
        ),
        d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setCatalog(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Coverage unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <label>
          Desk book{" "}
          <select
            aria-label="Desk book"
            disabled={busy}
            className={inputStyle}
            value={bookId}
            onChange={(e) => setBookId(e.target.value)}
          >
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.kind} · {b.accountAddress.slice(0, 8)} ·{" "}
                {b.isTestnet ? "Paper / testnet" : "Mainnet"}
              </option>
            ))}
          </select>
        </label>
        <Link href="/desk" className="text-cyan-300">
          Manage desk and paper trading →
        </Link>
      </div>
      {!books.length && (
        <p>
          Create a desk book to run research. Its risk limits also govern
          historical experiments.
        </p>
      )}
      {book && (
        <>
          <p className="text-slate-400">
            Book mandate v{book.version}. Paper trading is active Hyperliquid
            testnet execution. Historical results below use{" "}
            {testnet ? "testnet" : "mainnet"} observations and do not place
            orders.
          </p>
          <p className="text-slate-400">The whole native perpetual market is eligible. Candle history is fetched automatically; missing periods and actual test resolution are reported. Results never activate a strategy.</p>
          <form
            onSubmit={submit}
            className="rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-5"
          >
            <label className="flex flex-col gap-2">
              Trading hypothesis
              <textarea
                required
                minLength={8}
                maxLength={2000}
                value={hypothesis}
                onChange={(e) => setHypothesis(e.target.value)}
                className={inputStyle}
                placeholder="What market behavior should this rule capture, and when should it fail?"
              />
            </label>
            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex flex-col">
                Historical source
                <select
                  className={inputStyle}
                  value={source}
                  onChange={(e) => {
                    const next=e.target.value;setSource(next);setVariants([]);
                    setIntervalSeconds(next==="venue_candles"?3600:60);
                    setStart(localDate(new Date(Date.now()-(next==="venue_candles"?90*86400000:6*3600000))));
                    setRule({...initialRule,signal:next==="venue_candles"?"trend_pullback":"momentum",maxHoldBars:next==="venue_candles"?24:30});
                  }}
                >
                  <option value="venue_candles">Venue candles: multi-day swing research</option>
                  <option value="collector">
                    Collector: recorded top of book
                  </option>
                  <option value="archive">Archive: historical L2 depth</option>
                </select>
              </label>
              <label className="flex flex-col">
                Venue coins (up to three)
                <input
                  required
                  className={inputStyle}
                  value={symbols}
                  onChange={(e) => setSymbols(e.target.value)}
                />
              </label>
              <label className="flex flex-col">
                Observation interval
                <select
                  className={inputStyle}
                  value={interval}
                  onChange={(e) => setIntervalSeconds(Number(e.target.value))}
                >
                  {(source==="venue_candles"?[300,900,3600]:[10,30,60]).map((n) => (
                    <option key={n} value={n}>
                      {n} seconds
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col">
                From (local time)
                <input
                  required
                  type="datetime-local"
                  className={inputStyle}
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label className="flex flex-col">
                Through (local time)
                <input
                  required
                  type="datetime-local"
                  className={inputStyle}
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
              <button
                disabled={busy}
                type="button"
                className={inputStyle}
                onClick={() => void loadCatalog()}
              >
                Inspect available history
              </button>
              <label className="flex flex-col">
                Fee assumption per side (bps)
                <input
                  required
                  type="number"
                  step="any"
                  min={0}
                  max={100}
                  className={inputStyle}
                  value={fee}
                  onChange={(e) => setFee(e.target.valueAsNumber)}
                />
              </label>
              <label className="flex flex-col">
                Additional slippage (bps)
                <input
                  required
                  type="number"
                  step="any"
                  min={0}
                  max={100}
                  className={inputStyle}
                  value={slippage}
                  onChange={(e) => setSlippage(e.target.valueAsNumber)}
                />
              </label>
            </div>
            {catalog && (
              <details open>
                <summary>History coverage</summary>
                <div className="max-h-64 overflow-auto text-sm">
                  <p>{source==="venue_candles"?catalog.candles?.history:catalog.collector?.depth}</p>
                  {source==="venue_candles" && <p>{catalog.candles?.fidelity}</p>}
                  {source === "collector" && catalog.collector?.reason && (
                    <p>{catalog.collector.reason}</p>
                  )}
                  <table className="w-full text-left">
                    <thead>
                      <tr>
                        <th>Instrument</th>
                        <th>First observation</th>
                        <th>Latest observation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(source === "archive"
                        ? catalog.archive?.coverage
                        : source==="collector" ? catalog.collector?.coverage : []
                      )?.map((c: any, i: number) => (
                        <tr key={i}>
                          <td>{c.instrumentId}</td>
                          <td>{c.first}</td>
                          <td>{c.last}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {source === "archive" &&
                    catalog.archive?.status === "unavailable" && (
                      <p>{catalog.archive.reason}</p>
                    )}
                </div>
              </details>
            )}
            <fieldset className="border-t border-slate-700 pt-4">
              <legend className="text-lg">Rule variants</legend>
              <div className="grid gap-4 md:grid-cols-3">
                <label className="flex flex-col">
                  Variant name
                  <input
                    required
                    className={inputStyle}
                    value={rule.name}
                    onChange={(e) => setRule({ ...rule, name: e.target.value })}
                  />
                </label>
                <label className="flex flex-col">
                  Signal
                  <select
                    className={inputStyle}
                    value={rule.signal}
                    onChange={(e) =>
                      setRule({
                        ...rule,
                        signal: e.target.value as Rule["signal"],
                      })
                    }
                  >
                    {source==="venue_candles" && <option value="trend_pullback">Trend / pullback / resumption</option>}
                    <option value="momentum">Momentum</option>
                    <option value="mean_reversion">Mean reversion</option>
                    <option value="breakout">Breakout</option>
                  </select>
                </label>
                <label className="flex flex-col">
                  Direction
                  <select
                    className={inputStyle}
                    value={rule.side}
                    onChange={(e) =>
                      setRule({ ...rule, side: e.target.value as Rule["side"] })
                    }
                  >
                    <option value="both">Both</option>
                    <option value="long">Long</option>
                    <option value="short">Short</option>
                  </select>
                </label>
                {Object.entries(numericLabels).map(([key, label]) => (
                  <label className="flex flex-col" key={key}>
                    {label}
                    <input
                      required
                      type="number"
                      min={
                        key === "thresholdBps" || key === "cooldownBars"
                          ? 0
                          : key.endsWith("Bars")
                            ? 1
                            : 0.01
                      }
                      step={key.endsWith("Bars") ? 1 : "any"}
                      className={inputStyle}
                      value={rule[key as keyof Rule]}
                      onChange={(e) =>
                        setRule({ ...rule, [key]: e.target.valueAsNumber })
                      }
                    />
                  </label>
                ))}
              </div>
              <button
                type="button"
                disabled={variants.length >= 6}
                className={inputStyle + " mt-4"}
                onClick={() => {
                  if (variants.some((v) => v.name === rule.name)) {
                    setError("Use a distinct variant name.");
                    return;
                  }
                  setVariants([...variants, { ...rule }]);
                }}
              >
                Add to comparison ({variants.length}/6)
              </button>
              {variants.length > 0 && (
                <ul>
                  {variants.map((v, i) => (
                    <li key={v.name} className="flex gap-4 py-1">
                      {v.name} · {v.signal} · ${v.orderUsd}
                      <button
                        type="button"
                        aria-label={"Remove " + v.name}
                        onClick={() =>
                          setVariants(variants.filter((_, j) => i !== j))
                        }
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <p className="text-sm text-slate-400">
              {source === "venue_candles" ? "The first 50% develops the rule, the next 25% selects one fixed candidate, and the last 25% stays untouched until selection. Holding-period buffers separate these periods. One capital pool covers all instruments within each period." : "Depth replay uses 60% development, 20% validation and 20% holdout with separate starting capital for each period."}
              {" "}Repeated experiments can overfit. Actual coverage, costs, funding and modeled execution limits remain explicit.
            </p>
            <button
              disabled={busy || !bookId}
              className="rounded bg-cyan-700 px-4 py-2"
              type="submit"
            >
              {busy ? "Submitting…" : "Queue desk experiment"}
            </button>
          </form>
        </>
      )}
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <section>
          <h2 className="text-lg mb-3">Research history</h2>
          {runs.map((r) => (
            <button
              key={r.id}
              disabled={busy}
              className="block w-full border-b border-slate-700 p-3 text-left"
              onClick={() => setSelected(r.id)}
            >
              <strong>{r.status}</strong> ·{" "}
              {new Date(r.createdAt).toLocaleString()}
              <p className="text-sm text-slate-400">{r.hypothesis}</p>
            </button>
          ))}
        </section>
        {result && (
          <section className="space-y-3">
            <h2 className="text-lg">
              Run {result.runId.slice(0, 8)} · {result.status}
            </h2>
            {result.error && <p role="alert">{result.error}</p>}
            {["queued", "running"].includes(result.status) && (
              <button
                className={inputStyle}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await fetch("/api/backtest/run", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "cancel",
                        bookId,
                        runId: selected,
                      }),
                    });
                    const d = await r.json();
                    if (r.ok) setResult(d);
                    else setError(d.error);
                  } catch (e) {
                    setError(
                      e instanceof Error ? e.message : "Cancellation failed.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Cancel research
              </button>
            )}
            {result.result && <ResearchResults data={result.result} />}
            {result.resultArtifactId && (
              <a
                className="block text-cyan-300"
                href={
                  "/api/backtest/run?" +
                  new URLSearchParams({
                    bookId,
                    artifactId: result.resultArtifactId,
                  })
                }
                target="_blank"
                rel="noreferrer"
              >
                Open complete result and fill ledger
              </a>
            )}
            {result.datasetArtifactId && (
              <a
                className="block text-cyan-300"
                href={
                  "/api/backtest/run?" +
                  new URLSearchParams({
                    bookId,
                    artifactId: result.datasetArtifactId,
                  })
                }
                target="_blank"
                rel="noreferrer"
              >
                Open exact observations used
              </a>
            )}
            <details>
              <summary>Experiment manifest</summary>
              <pre className="overflow-auto text-xs">
                {JSON.stringify(result.manifest, null, 2)}
              </pre>
            </details>
          </section>
        )}
      </div>
    </div>
  );
}
function ResearchResults({ data }: { data: any }) {
  const rows = [
    ...(data.variants ?? []).map((v: any) => ({
      name: v.name + " / validation",
      ...v.validation,
    })),
    ...(data.stressedHoldout ? [{name:data.selectedVariant + " / doubled-cost holdout",...data.stressedHoldout}] : []),
    ...(data.holdout
      ? [{ name: data.selectedVariant + " / holdout", ...data.holdout }]
      : []),
    ...(data.replay ? [{ name: "Recorded orders", ...data.replay }] : []),
  ];
  return (
    <>
      <p>{data.hypothesis}</p>
      {data.scope === "chronological_candle_swing" ? <p>Requested candle coverage: {data.coverage.complete ? "complete" : "incomplete; inspect periods below"}. Assessment: {data.assessment?.status}. {data.partitions?.purgeHours}h separation between evaluation periods.</p> : data.coverage.windows ? <p>Recorded-depth campaign: {data.coverage.windows.length} independent windows. Assessment: {data.assessment?.status}.</p> : <p>Coverage: {data.coverage.expectedBooks - data.coverage.missingBooks}/{data.coverage.expectedBooks} books; {data.coverage.missingFunding} missing funding observations.</p>}
      {data.assessment && <p>{data.assessment.note}</p>}
      <details><summary>Coverage, evaluation periods and benchmarks</summary><pre className="overflow-auto text-xs">{JSON.stringify({coverage:data.coverage,partitions:data.partitions,benchmarks:data.benchmarks},null,2)}</pre></details>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Evaluation</th>
              <th>Net P&amp;L</th>
              <th>Drawdown</th>
              <th>Fills</th>
              <th>Open positions</th>
              <th>Rejections</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td>{r.metrics.netPnlUsd.toFixed(2)}</td>
                <td>{r.metrics.maxDrawdownPct.toFixed(2)}%</td>
                <td>{r.metrics.fills}</td>
                <td>{r.endingPositions.length}</td>
                <td>{r.metrics.rejectedOrders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.selectedVariant && !data.replay && (
        <p>
          No eligible validation candidate. Inspect fills, rejections and data
          completeness.
        </p>
      )}
      {[
        ...new Set<string>([
          ...data.limitations,
          ...rows.flatMap((r: any) => r.limitations ?? []),
        ]),
      ].map((l) => (
        <p className="text-sm text-slate-400" key={l}>
          {l}
        </p>
      ))}
      <details>
        <summary>Costs, open positions and rejection details</summary>
        <pre className="overflow-auto text-xs">
          {JSON.stringify(
            { assumptions: data.assumptions, evaluations: rows },
            null,
            2,
          )}
        </pre>
      </details>
    </>
  );
}
export function Backtester() {
  const { walletSessionAddress, isTestnet } = useTrading();
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-semibold">Desk research</h1>
      <p className="text-slate-400">
        Test a trading hypothesis with the desk’s execution rules and fixed risk
        limits.
      </p>
      {walletSessionAddress ? (
        <ResearchSession
          key={walletSessionAddress + ":" + isTestnet}
          owner={walletSessionAddress}
          testnet={isTestnet}
        />
      ) : (
        <p>
          Connect and authenticate your wallet to view book-scoped research.
        </p>
      )}
    </div>
  );
}
