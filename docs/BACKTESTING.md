# Evaluate strategies on historical bars

Phase 4 compares VWAP momentum with a session buy-and-hold benchmark over the same declared sessions and risk/cost settings. A third strategy replays archived AI decisions when they are supplied. Evaluation never calls a model or broker, changes the process clock, or submits orders to the paper wallet.

## Try the complete workflow

1. Restart the backend with `pnpm paper:demo` and open http://127.0.0.1:8080/#backtesting.
2. Click **Load synthetic example**. It provides four complete sessions for two symbols. These are generated prices, not historical market evidence.
3. Keep both deterministic strategies selected. Choose the first session, last session, holdout start and starting capital. Expand **Costs, risk and strategy parameters** to change assumptions.
4. Click **Run comparison**. Results default to the holdout window. Compare metrics, equity paths, trade reasons and costs. Switch **Evaluation window** to inspect in-sample results separately.
5. Open **Assumptions & provenance** for the frozen configuration, strategy/model versions, dataset hash, run fingerprint and rejected entries.
6. Use **Export result JSON** to download the complete result, or reopen it from **Saved evaluations** after restart. Identical data/configuration/evaluator versions reuse the same saved run.

No new `.env` settings are required. The paper balance at the top is the operating account; the evaluation's starting/ending cash appears inside the results and stays separate.

## Supply historical data

Use **Import dataset JSON** with a file up to 4 MiB. Generate a complete, valid synthetic format example with:

```powershell
pnpm backtest:fixture
```

This creates `data/backtest-fixture.json` without overwriting an existing file. To use another output path:

```powershell
pnpm backtest:fixture data/another-fixture.json
```

Replace its generated data with sourced historical bars. Required fields:

| Field | Meaning |
| --- | --- |
| `name` | Dataset name, up to 80 characters |
| `source` | Provider, acquisition/export identity and corporate-action adjustment convention; up to 200 characters |
| `synthetic` | Explicit boolean. Use `true` for generated or demonstration data |
| `universeAsOf` | ISO date of the declared historical universe, on/before the first session |
| `dates` | Explicit ISO session-date array; missing whole sessions cannot silently disappear |
| `symbols` | Explicit historical symbol array; a member missing from every row still fails validation |
| `bars` | One-minute `{symbol, ts, open, high, low, close, volume}` objects |
| `decisions` | Optional archived AI decisions described below |

OHLC prices are INR, timestamps are Unix milliseconds at candle **start**, and volume is that minute's positive traded volume, not cumulative daily volume. Each declared symbol/session needs exactly 375 unique contiguous bars from 09:15 through 15:29 IST. OHLC bounds, weekday/session alignment, duplicate timestamps and missing members are checked. Maximum 30 sessions, 20 symbols and 30,000 bars. The intersection of these limits applies.

For already recorded bars, expand **Capture existing local bars**, supply the date range, historical symbols and universe date, and declare whether the bars are synthetic. Capture reads only that range and those symbols. A synthetic active feed forces the synthetic label. The cache's original source/adjustment provenance is marked unverified. Capture expects every weekday; for exchange holidays import JSON with an explicit session list. It rejects partial days instead of quietly selecting only complete survivors.

A declared historical membership list is required, but the application cannot authenticate it. Verify data provenance, adjusted prices, historical membership, missing sessions and delisted names independently. Current Nifty 50 survivors are not a valid default for an old period. Missing/delisted histories must be resolved in the input; the runner will not drop the member or invent a final price. There is no automatic broker download or corporate-action feed in this delivery.

## Replay recorded AI decisions

Add `decisions` objects with these fields:

```json
{
  "symbol": "INFY",
  "ts": 1792383300000,
  "featureBarTs": 1792383240000,
  "trainingEnd": 1792300000000,
  "action": "BUY",
  "stopLoss": 99.50,
  "modelVersion": "your-archived-model-version",
  "reason": "Archived entry explanation"
}
```

The timestamps above illustrate the field shapes; use timestamps matching your actual dataset. `action` is BUY, SELL or HOLD. BUY requires a stop below the execution opening and within the configured stop-distance limit. `featureBarTs` must identify a supplied bar that fully closed before the decision; the declared model training cutoff must precede the entire dataset. Duplicate symbol/decision timestamps fail validation. A decision executes at the first opening at or after its availability time, within that session; later decisions cannot act earlier. Unrecorded times mean HOLD.

Selecting **Recorded AI decisions** replays this archive under the same cash, cost, stop and account limits. It does not regenerate historical judgments with today's model. Sparse archives, forged timestamps, model pretraining knowledge and missing provider activity cannot be independently certified. Source and version evidence remain the data owner's responsibility. Synthetic recorded decisions test this path but do not establish AI performance.

## Fill and accounting assumptions

- Long-only whole shares; full fills, no leverage or partial fills. Cash, maximum order value, maximum positions, stop distance and daily loss checks apply. Simultaneous entries are allocated by symbol name, not a hindsight ranking.
- VWAP uses the existing completed-bar strategy. Decisions use only bars closed at that moment and execute at the next candle opening. Current candle volume is never used to size an opening fill; the prior minute supplies a participation ceiling. Orders exceeding it are rejected rather than clipped.
- The benchmark buys each session opening and liquidates at the session close. It is **intraday session buy-and-hold**, not an overnight buy-and-hold return. Opening benchmark liquidity is assumed because no prior-session book is provided; this exception is explicit in every saved result.
- Protective stops exist after entry, fill at the trigger if crossed, and at a worse opening on gaps. Their intrabar time is unknown and recorded at bar end. There are no target/limit orders whose intrabar ordering would need guessing.
- A hold-time or daily loss threshold observed at a candle close exits at the next opening. Maximum-hold settings therefore can be exceeded by one minute. Daily loss checks and drawdown use minute-close marks, so intrabar losses can be worse. New buys stop after the daily halt; the next session resets the daily baseline.
- All positions liquidate at the last supplied session candle close using a predeclared session-close rule, plus exit costs. All declared sessions are complete; unclosed positions cause failure. Overnight market exposure is excluded.
- The raw fill price is the candle opening, stop or liquidation close, rounded to paise. Fee = `ceil(raw notional × feeBps / 10000)`. Friction = `ceil(raw notional × (fullSpreadBps / 2 + slippageBps) / 10000)`. Both are adverse charges on each side. They are separate from raw trade prices; flat estimates do not itemize actual broker taxes or model execution queues.

## Metrics and holdout integrity

Each window starts with the same fresh cash for each strategy. The in-sample window ends before the holdout date; the holdout includes that date through the last session. No cash/position carries from tuning into the holdout, and no automatic fitting occurs. Choose parameters using the earlier period only. Repeatedly tuning against this holdout makes it in-sample in practice; use a new unseen period.

Gross P&L is raw exit-minus-entry notional. Net P&L subtracts fees and spread/slippage. Win rate counts positive-net closed trades over all closed trades. Average win/loss, expectancy, profit factor, close-marked maximum drawdown, average holding time, trade count, time exposure and return on starting capital are reported. Undefined ratios show a dash; no losing trades is explicitly labeled rather than converted into a fictional finite profit factor. Equity marks open shares at the close after costs already paid; final liquidation includes exit costs. Time exposure is the fraction of replay minutes with holdings, not the percentage of capital deployed.

The declared data, source, universe date, full parameters, evaluator version, strategy versions, recorded model versions and SHA-256 hashes are frozen with each run. No new data is fetched on rerun. This makes the calculation repeatable; it does not certify the input's truth or live profitability.

## Local API and limits

All endpoints use existing loopback, Host, same-origin and no-store protections, including observe mode. Evaluations are available without a paper account.

| Endpoint | Purpose |
| --- | --- |
| GET `/api/backtests` | Dataset metadata and saved-run summaries |
| POST `/api/backtests/demo` | Import the labeled deterministic fixture |
| POST `/api/backtests/import` | Validate/store dataset JSON; 4 MiB bounded body |
| POST `/api/backtests/capture` | Validate/capture the specified range/universe from the local cache |
| POST `/api/backtests/run` | Evaluate one to three selected strategies with `datasetId`, dates, holdout, capital, risk/cost settings and optional strategy parameters |
| GET `/api/backtests/:id` | Complete immutable saved result |

Results and datasets use separate `backtest_*` tables in the configured database. No legacy replay records or paper records are reset. Stored datasets are limited to 20 and runs to 100. There is no destructive cleanup endpoint. CPU work uses one worker at a time, a 15-second evaluation deadline and a 128 MiB worker heap limit; concurrent new runs receive a retryable conflict. Larger studies require deliberate capacity changes rather than silently blocking the paper event loop.

## Verification and remaining limits

The suite checks known metrics by hand, future-price invariance, next-open execution, prior-volume sizing, gap stops, daily loss halts, complete member/session validation, independent holdout cash, recorded-AI cutoffs, persisted deduplication, event-loop availability and unchanged paper records. Real localhost API checks cover dataset/run routes, origin protection and unchanged paper balances. Browser checks cover fixture loading, comparisons, window/strategy switching and reopening saved results. The browser file chooser loses its automation session in this environment; dataset import and recorded-AI runs are verified through the actual HTTP API instead.

Real historical data/provider authenticity, exchange calendars, corporate actions, true order-book liquidity, live model outputs and profitability are not certified. This is a local research evaluation workflow, not a claim of deployable returns. Legacy interactive replay remains separately accessible and is not retrospectively certified by the new evaluator.
