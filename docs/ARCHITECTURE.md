# DipDaemon architecture

Audited local source on 26 October 2026. Git initially has no commits and all application files are untracked. No upstream comparison or broker certification was performed.

## Current process

```text
main.ts -> createBroker -> Engine -> startServer -> web dashboard
                            |
       login + instruments + candle warmup + LiveFeed quotes
                            |
  SQLite bars/snapshots -> features -> model stage 1 -> stage 2
                            |
  spread/RVOL/news/session gates -> risk sizing -> margin check
                            |
  Executor.place -> polling -> fills -> Engine.handleFill
                            |
  positions + stops + model exits -> trades -> HTTP state/SSE
```

The two-second fast loop handles quotes, fills, stops, caps, and flattening. Entry scans and position-model checks have separate cadences and busy flags. SQLite is a global connection opened on import. The HTTP server and plain HTML/JavaScript/CSS dashboard share the engine process.

Inherited startup instantiated `LiveExecutor` regardless of model. Entry methods checked `canTrade`, but reconciliation directly cancelled broker orders or flattened positions. Jev or `ALLOW_MOCK_TRADING=1` authorized entries. Phase 0 makes normal operation observe-only, skips reconciliation, and blocks mutations in both real clients. Live source remains for later review.

## Inherited contracts and coupling

`Broker` combines session, instruments, quotes, candles, options, margin, order mutations, order reads, and position reads. `createBroker` selects Kotak or Zerodha. Market data and trading capabilities are coupled at this boundary.

`Executor` defines place, modify, cancel, cancelAll, tick, an in-memory order map, and a synchronous `onFill` callback. `PlaceIntent` contains routing, side, quantity, price, stops, decision, leg, tier, and optional time-in-force. It lacks account identity, idempotency, quote provenance, and validated money types.

`Engine.handleFill` owns position updates and stop placement. Executors persist fills before launching the asynchronous callback. Fill, position, and trade writes are not one atomic transaction. Pending orders and closed quantities are not fully reconstructed after restart. Paper accounting must commit before observers run.

## Inherited SQLite tables

`src/db.ts` enables WAL and a three-second busy timeout, then runs `CREATE TABLE IF NOT EXISTS`. Tables: snapshots, bars_1m, decisions, rankings, orders, fills, trades, positions, governor_log, context, events, settings, sessions. Bars have a symbol/timestamp primary key; snapshots and decisions have time indexes. Money uses REAL. Fills have a simulated flag, but orders and positions lack account ownership.

The inherited initialization DDL has no migration versions, wallet ledger, cash reservation, unique fill identity, or enforced foreign-key relationship. Phase 1 adds separate paper tables rather than reinterpreting these records.

## Implemented Phase 1 boundary

`src/portfolio/types.ts` validates paper settings and manual order inputs. `PaperWallet` receives an explicit SQLite connection, creates additive `paper_*` schema version 1 with foreign keys and uniqueness constraints, and derives cash from ledger postings. Pending-order rows and events provide durable cash/share reservations. `PaperExecutor` receives only that store, a read-only quote-map getter, settings, and a kill predicate. It has no broker reference.

Submission, fill, cash posting, position update, and completed sale record use one immediate SQLite transaction. Recovery queries persisted orders and positions without broker-account reconciliation or a second initial deposit. Monetary fields are integer paise. Per-date equity baselines and loss halts persist in paper_days.

PaperExecutor exposes the shared PlaceIntent through `place(intent & { idempotencyKey })`, plus validated manual `submit`, `modify`, `cancel`, `tick`, and account/read methods. It intentionally does not implement the legacy Executor's in-memory map and asynchronous onFill accounting callback. Reusing that callback would split a paper fill across transactions and duplicate Engine.handleFill mutations. Phase 2 must integrate signals through the paper intent method, not the legacy callback.

`src/main.ts` constructs the paper service only for explicit paper mode, adds held/pending symbols to the quote feed, and ticks paper risk/fills after data updates. The scanner's execution remains observe-only. `src/api/paper.ts` provides local JSON account/order/journal APIs. Live broker guards are unconditional in both modes. `scripts/paper-demo.ts` provides an explicitly synthetic offline quote source, virtual clock, and isolated persistent demo account.

Full assumptions and commands are in [Paper trading](PAPER_TRADING.md). The inherited replay simulator stays separate; candle input is not passed to the new quote-based fill policy.

## Replay

`scripts/replay.ts` chooses a separate DB and kill file, copies historical bars, optionally fetches missing candles, and injects SimBroker/SimExecutor. Backward seeking clears simulation records and rebuilds the engine. Replay may call Jev or broker data endpoints, so it is not inherently offline.

`loadBars` constrains `ts <= clock.now()`. SimExecutor requires a quote bar strictly later than the placement bar. Limits fill at a touched limit or favorable opening gap; stops fill at the trigger or adverse opening gap. Forced exits use the next eligible open. Prices are clamped to candle range. Full quantities fill without liquidity constraints or price slippage. Stops approximate trigger execution rather than stop-limit gap behavior.

Replay generally advances to minute start plus 59 seconds. Initial boot uses the first timestamp and can already expose that candle's full OHLC. Snapshot queries lack an upper clock bound. Same-candle entry/stop ordering and asynchronous fill callbacks need regression tests. The code has safeguards, but end-to-end no-look-ahead correctness is unproven.

## Original design direction

The Phase 2 automation boundary is implemented in `src/automation/paper.ts`. It consumes timestamped market snapshots and validated baseline/AI decisions, stores versioned signal/run records, and submits only through the paper intent API. Manual approvals and automatic scheduling share one execution gate. Configuration revisions invalidate pending/in-flight work; per-signal idempotency, symbol cooldowns and current-price/risk rechecks prevent duplicate or outdated orders. Strategy exits manage only positions linked by schema version 2's entry_order_id to an accepted automation buy signal.

The existing engine still runs its observe/replay paths and supplies market data/model interfaces. Strategy service construction and ticking are explicit in main and the synthetic demo; legacy asynchronous fill callbacks never mutate paper records. This keeps the market scanner reusable without coupling strategy automation to live broker capabilities. See [Automation](AUTOMATION.md) for rules and APIs.

## Phase 3 browser boundary

The local server serves the new workspace as native browser modules. `/api/dashboard` collects market context, paper account/positions/orders/trades, strategy signals/runs/events and recorded-session metadata in a SQLite transaction. It uses the existing loopback, Host and same-origin checks and returns `Cache-Control: no-store`. Observe/replay snapshots contain no paper account. No credential values are included.

The browser polls while visible, formats integer paise as INR, preserves active inputs and keeps order request keys across ambiguous responses within the current page session. It submits intents to the existing paper and automation APIs; accounting, sizing, execution and risk remain on the backend. Disconnection disables actions and retains the last snapshot. The original dashboard is preserved at `/legacy.html`; historical performance evaluation remains Phase 4. See [browser operation](DASHBOARD.md).

Keep a modular monolith and SQLite. Construct the market-data reader separately from the selected executor. Strategies emit validated signals and order intents independent of mode. An observe executor records decisions without creating orders. PaperExecutor depends on quotes and a paper store, never a trading-capable broker.

```text
timestamped data -> strategy -> deterministic risk -> intent
                                                     |
                   observe: log     paper: PaperExecutor
                                               |
                     SQLite transaction: order/events/fill
                           + reservation/ledger/position
                                               |
                                      read models -> API
```

Post money in integer paise with explicit rounding. The durable ledger is authoritative. Reserve permitted cash plus estimated costs before accepting a buy; reserve shares for pending sells. Count pending buys toward position limits. Release reservations on cancellation, rejection, or expiry. Each fill commits exactly once with cash, fees, position, and order status in the same transaction.

The MVP uses whole shares, full fills, long-only cash equities. Validate finite positive prices, integral quantities, bid/ask ordering, quote age, and market session. A market buy uses ask plus slippage; a sell uses bid minus slippage. A limit never fills outside its price. Resting limits wait for fresh eligible data. Missing or stale quotes produce no fill. Costs and slippage remain separate versioned assumptions.

Persist client idempotency keys; reject reuse with different payloads. Reject unsupported partial fills and position increases explicitly. Recover paper orders, reservations, positions, and ledger without broker-position reads. Keep replay's next-bar policy distinct from quote execution. Live mode stays disabled.

## Decisions

- Preserve feature engineering, model interface, engine, and replay instead of rewriting them.
- Block mutations at broker boundaries because engine entry guards miss recovery paths.
- Permit explicit paper mode with the isolated account; reject live configuration until separately authorized and reviewed.
- Retain SQLite; there is no demonstrated need for distributed storage or queues.
- Defer frontend replacement until paper accounting and APIs pass offline tests.
