# Existing feature inventory

Source inspection on 26 October 2026. Implemented means code exists, not that external service behavior was exercised. See [validation evidence](SAFETY.md).

| Component | Implementation found | Disposition |
| --- | --- | --- |
| `src/main.ts` | Broker construction, startup, ticks, signals, empty dashboard without credentials | Reuse with modifications: fixtures, connection state, awaited shutdown |
| `src/engine.ts` | Warmup, screening, risk gates, entries, stops, exits, recovery, sessions | Refactor: mode routing and paper accounting ownership |
| `src/config.ts`, `risk.json`, `.env.example` | Environment/risk settings; unchecked numbers and fallback enums | Reuse with modifications: strict parsing and paper settings |
| `src/execution-policy.ts` | Phase 0 safe mode parsing and broker mutation block | Reuse unchanged initially |
| `src/broker.ts` | Shared data/account/trading interface and factory | Refactor: separate data from trading capability |
| `src/zerodha/client.ts`, `instruments.ts` | Auth, instrument parsing, quotes, history, margins, orders, positions | Reuse with modifications; mutations blocked, external behavior unverified |
| `src/kotak/client.ts`, `scrip.ts` | TOTP login, instrument parsing, data and account APIs | Reuse with modifications; retain secondary provider, mutations blocked |
| `src/data/feed.ts`, `bars.ts` | REST polling, snapshots, bar aggregation, replay/candle feeds | Reuse with modifications: freshness and candle completion semantics |
| `src/data/features.ts` | VWAP, ATR, returns, RVOL, trend, spread, book and flow | Reuse with modifications: clock bounds and deterministic tests |
| `src/data/universe.ts`, `symbols.ts` | Static Nifty 50 universe, aliases, filtering, cooldown | Reuse with modifications: membership dates and provenance |
| `src/model/index.ts`, `jev.ts` | Model interface, gateway/direct Jev, deadlines, retry, decision persistence | Reuse with modifications: runtime output schemas and versions |
| `src/model/mock.ts`, `questions.ts` | Mock answers and structured question sets | Reuse with modifications: fixture and invalid-output coverage |
| `src/strategy/continuation.ts` | Two-stage long/short rankings, regime, weighted gates | Reuse with modifications: typed signals and long-only paper filter |
| `src/strategy/exits.ts`, `governor.ts` | Exit votes, time exits, trade allowance and loss governor | Reuse with modifications: account risk and audit reasons |
| `src/strategy/options.ts` | Optional Nifty option signals and strike selection | Replace later for product scope; retain source outside paper MVP |
| `src/executor/types.ts` | Intent, Fill and Executor contracts | Reuse with modifications: identity and transactional fills |
| `src/executor/live.ts` | Placement, requotes, cancel, poll, estimated fill costs | Reuse with modifications later; disabled now |
| `src/replay/sim.ts` | SimBroker/SimExecutor, next-bar fills | Reuse with modifications; not a durable paper account |
| `src/replay/control.ts`, `manager.ts` | Pause/speed/seek, local replay child processes | Reuse with modifications: validation, limits, shutdown |
| `src/db.ts` | Global WAL SQLite audit/history/settings/session tables | Refactor: migrations, injected store, atomic account ledger |
| `src/risk.ts` | ATR stops, sizing, position/loss caps, unrealized P&L | Reuse with modifications: finite inputs, pending exposure, account loss |
| `src/costs.ts` | Statutory fee estimates and friction | Reuse with modifications: brokerage, effective dates, separate slippage |
| `src/time.ts`, `limiter.ts` | IST helpers, virtual clock, broker throttling | Reuse unchanged initially |
| `src/context.ts`, `alerts.ts` | RSS/model context, SQLite/Telegram alerts, crash handler | Reuse with modifications: explicit external effects, secret-safe diagnostics |
| `src/server.ts` | State, SSE, kill/resume, Jev pause, wild/capital and replay controls | Reuse with modifications: validation, paper APIs, access control |
| `web/index.html`, `app.js`, `style.css` | Terminal dashboard and replay controls | Replace later in Phase 3; retain now |
| `scripts/smoke.ts` | Fixed-clock scratch DB features/ranking/sizing smoke; candidate, size and capital assertions; safe cleanup on import failure | Reuse unchanged initially |
| `scripts/safety.test.ts`, `scripts/lifecycle.test.ts` | Mode and actual client mutation tests; fixture Engine/SQLite lifecycle isolation across eight configurations | Reuse with modifications: add paper lifecycle coverage in Phase 1 |
| `scripts/replay.ts` | History loading, replay runner and seek reset | Reuse with modifications: reproducibility and offline-only input |
| `scripts/calibrate.ts` | Candle/model calibration study | Reuse with modifications: tuning/evaluation split |
| `scripts/report.ts`, `gates.ts` | P&L, hit rate, expectancy, PF, trade drawdown, readiness summaries | Reuse with modifications: portfolio equity, no-loss PF, benchmarks |
| `scripts/probe.ts`, `zerodha-login.ts` | Broker inspection and manual token exchange | Reuse unchanged initially; exclude from offline checks |
| `deploy/warren-duffer.service` | Linux restart template and inherited installation path | Reuse with modifications in Phase 5 |
| Package, lockfile, TypeScript config | Node/tsx, strict TypeScript, SQLite, AI, dotenv, TOTP, RSS | Reuse with modifications: branding and test commands |
| `LICENSE` | MIT copyright 2026 arimanyus | Reuse unchanged |

No module or dependency was proven obsolete; none was removed. AI, RSS, and TOTP dependencies have callers. Live and replay executors duplicate order persistence, but merge that code only after the paper transaction boundary is defined. Node's built-in test runner with installed tsx suffices for Phase 0; no new dependency was added.

## Missing paper behavior

There is no PaperExecutor, account, cash/reservation ledger, durable idempotency key, paper configuration, or manual paper-order API. Capital is a sizing setting, not cash. REAL-valued trade P&L is not a reconciled wallet. SimExecutor pending state is in memory. Observe lifecycle isolation is now tested; paper recovery, duplicate fills, and stale quote execution remain unimplemented and untested.

`PAPER_INITIAL_CAPITAL`, `PAPER_MAX_ORDER_VALUE`, `PAPER_MAX_POSITIONS`, and `PAPER_DAILY_LOSS_LIMIT` are not parsed. A standalone deterministic quantitative strategy, walk-forward evaluation, and benchmark comparison are missing. Replay and reporting do not satisfy Phase 4 acceptance criteria.
