# Backtest of price alerts for passed trades

The window runs from November 17, 2026 at 19:42 through November 19 at 19:42 Paris time (18:42 UTC on each date). The enabled mainnet directional book recorded 264 live pass watches. Of those, 54 named a directional price level that could trigger a fresh review. The two-close rule would have generated 27 alerts across 23 instruments. Fourteen reached their original deadline without a subsequent recorded investigation of that instrument.

## What the desk would have seen

| Outcome | Count |
|---|---:|
| Registered live passes | 264 |
| Passes with an explicit directional level | 54 |
| Two consecutive 15-minute closes beyond the level before expiry | 27 |
| Expired without an alert | 22 |
| Still within the observation window, no alert yet at cutoff | 5 |

In 12 of the 27 alert cases, the instrument never appeared in another live candidate comparison during that watch’s remaining horizon. Two others appeared only in screening. The desk subsequently investigated the other 13, with a median of 28 minutes from the simulated alert to the written comparison. The first recorded disposition was pass in 12 cases and defer in one. The journal timestamps measure when the desk recorded its work. Deliberation can start earlier.

Removing all eight examples used to formulate the rule leaves 22 alerts, 11 without a later investigation. These are additional cases from the same retrospective window. The prospective value of an alert depends on the decision the lead makes when called.

## Modeled returns

Each scenario enters in the original proposed direction and exits at the first whole minute at or after the saved observation deadline. Returns are equally weighted per idea. Cases can overlap. These figures describe individual entry and exit scenarios and do not model a capital-constrained portfolio.

| Scenario | Scored cases | Positive | Mean net return | Median net return |
|---|---:|---:|---:|---:|
| Enter each mature level-qualified idea after registration | 49 | 25 | −0.23% | +0.04% |
| Enter after one qualifying 15-minute close | 31 | 11 | −0.19% | −0.22% |
| Enter after two qualifying closes | 27 | 10 | −0.36% | −0.37% |
| Two closes, only cases without a subsequent investigation | 14 | 7 | −0.06% | −0.16% |
| Two closes, excluding the original eight examples | 22 | 9 | −0.41% | −0.33% |

The entry rules select different samples. The one-close rule generated 33 alerts. One deadline was still open at cutoff and one left too little time for a simulated entry. With two-close confirmation, a five-minute decision delay reduced the mean return to −0.45%. Doubling the execution allowance to 10 basis points per side gave a mean of −0.46%.

Among the 14 alerts without a later investigation, STRK had the best modeled return at +1.73%, and MEGA had the worst at −1.44%. This variation matters to the proposed workflow. An alert gives the desk another opportunity to evaluate the setup. Historical data cannot establish which of those setups the lead would have approved.

## Replay rules and coverage

- **Journal cohort.** Selected mainnet live `DeskWatch` rows of kind `pass` created in the window. Each row has a saved side and deadline. A candidate mentioned only in prose, without a registered pass watch, falls outside the cohort. Comparisons come from the same book’s live shifts.
- **Level selection.** Read the pass thesis and the same-shift candidate’s next step. Manually coded an explicit level or range that the desk associated with a directional break, recovery, retention, or extension. For a range, used its outer edge in the proposed direction. Excluded targets or invalidations mentioned only as payoff references, unspecified zones, news and depth conditions alone, and retests or failed rebounds requiring a price sequence without a distinct breakout level. The 210 uncoded rows and their original language are in the ledger. The interpretation of prose involves judgment.
- **Information timing.** Verified the original logged tool calls for all 54 coded watches and comparisons. Used the later of watch registration and the comparison request as the earliest possible start. Required two consecutive, complete Hyperliquid 15-minute bars that opened after or at that time and closed strictly beyond the level. An alert fires once, before the earlier of the saved deadline and cutoff. The price test isolates the observable part of the note. Volume, relative strength, depth, funding constraints, and remaining payoff can still disqualify an entry.
- **Return model.** Allowed two minutes after confirmation for a decision. Used the recorded one-minute candle open, 4.5 basis points in fees per side, 5 basis points of adverse execution per side, and the venue’s historical hourly funding rates. The candle open at the funding boundary proxies the settlement mark. The model includes hourly boundaries after entry and through exit. It omits stops, sizing, order-book walking beyond the stated allowance, and the lead’s discretionary response. The recorded deadline fixes a common endpoint for comparison. It was an observation deadline in the live system.
- **Quote coverage.** Searched the mainnet MarketTick archive for a two-sided quote in the first 60 seconds after each modeled entry and exit, with a book event no more than five seconds old at observation. Six entries and two exits had a qualifying quote. BTC was the sole case with quotes on both legs. The table therefore uses the same candle-based model throughout. No live orders were placed.
- **Replay data.** The snapshot contains the normalized journal records, relevant venue bars, funding rates and archived quote matches. The ledger includes the exact coded threshold, original note, alert, recorded follow-up and per-case modeled returns in basis points. [Pass ledger](pass-ledger.csv) · [Archived inputs](replay-inputs.json.gz) · [Replay script](replay.py)

Run `python3 replay.py` in this directory to regenerate the ledger and print the summary from the archived inputs.

