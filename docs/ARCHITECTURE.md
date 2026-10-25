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

## Contracts and coupling

`Broker` combines session, instruments, quotes, candles, options, margin, order mutations, order reads, and position reads. `createBroker` selects Kotak or Zerodha. Market data and trading capabilities are coupled at this boundary.

`Executor` defines place, modify, cancel, cancelAll, tick, an in-memory order map, and a synchronous `onFill` callback. `PlaceIntent` contains routing, side, quantity, price, stops, decision, leg, tier, and optional time-in-force. It lacks account identity, idempotency, quote provenance, and validated money types.

`Engine.handleFill` owns position updates and stop placement. Executors persist fills before launching the asynchronous callback. Fill, position, and trade writes are not one atomic transaction. Pending orders and closed quantities are not fully reconstructed after restart. Paper accounting must commit before observers run.

## SQLite

`src/db.ts` enables WAL and a three-second busy timeout, then runs `CREATE TABLE IF NOT EXISTS`. Tables: snapshots, bars_1m, decisions, rankings, orders, fills, trades, positions, governor_log, context, events, settings, sessions. Bars have a symbol/timestamp primary key; snapshots and decisions have time indexes. Money uses REAL. Fills have a simulated flag, but orders and positions lack account ownership.

There is no versioned migration runner, wallet ledger, cash reservation, unique fill identity, or enforced foreign-key relationship in initialization DDL. The full strategy-to-risk-to-fill chain is not modeled. Paper changes must be additive; inherited records must not become wallet events implicitly.

## Replay

`scripts/replay.ts` chooses a separate DB and kill file, copies historical bars, optionally fetches missing candles, and injects SimBroker/SimExecutor. Backward seeking clears simulation records and rebuilds the engine. Replay may call Jev or broker data endpoints, so it is not inherently offline.

`loadBars` constrains `ts <= clock.now()`. SimExecutor requires a quote bar strictly later than the placement bar. Limits fill at a touched limit or favorable opening gap; stops fill at the trigger or adverse opening gap. Forced exits use the next eligible open. Prices are clamped to candle range. Full quantities fill without liquidity constraints or price slippage. Stops approximate trigger execution rather than stop-limit gap behavior.

Replay generally advances to minute start plus 59 seconds. Initial boot uses the first timestamp and can already expose that candle's full OHLC. Snapshot queries lack an upper clock bound. Same-candle entry/stop ordering and asynchronous fill callbacks need regression tests. The code has safeguards, but end-to-end no-look-ahead correctness is unproven.

## Proposed Phase 1 design

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
- Reject paper and live configuration until implemented and authorized respectively.
- Retain SQLite; there is no demonstrated need for distributed storage or queues.
- Defer frontend replacement until paper accounting and APIs pass offline tests.
