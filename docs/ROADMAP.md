# DipDaemon roadmap

Updated 26 October 2026. Work stops after Phase 0 audit and narrow safeguards. No Phase 1 implementation is included.

## Phase status

| Phase | Status | Acceptance gate |
| --- | --- | --- |
| 0: audit and foundation | Completed | Source audit and docs done; SQLite repaired; type check, 11 safety/lifecycle tests, and deterministic offline smoke pass |
| 1: persistent paper trading | Planned | Open/close a virtual NSE position through API; correct durable balances, costs, P&L, recovery, isolation |
| 2: automated AI paper trading | Planned | Validated signals, deterministic baseline, approval/automatic paper workflows, audited exits |
| 3: dashboard | Planned | Browser operates the validated paper workflow through real APIs |
| 4: evaluation | Planned | Two strategies compared on identical historical periods with documented assumptions and held-out data |
| 5: reliability | Planned | Recoverable deployed paper service with health, backups, monitoring, secrets, and access control |
| 6: optional live trading | Blocked | Explicit separate authorization and independent execution, reconciliation, operational, and compliance review |

## Phase 0 completion evidence

1. Installed the official better-sqlite3 12.11.1 prebuilt binary for Node ABI 127, Windows x64. Replaced build-policy placeholders with explicit approvals for better-sqlite3 and esbuild. A subsequent pnpm run completed both native setup scripts successfully.
2. `pnpm typecheck`, `pnpm test:safety`, and `pnpm smoke` all pass. The safety suite reports 11 passing tests including eight configuration combinations. Smoke uses a fixed market-session clock and asserts candidate selection, nonzero whole-share sizing, and capital bounds.
3. `scripts/lifecycle.test.ts` runs the real Engine and SQLite on scratch files with fixture market data. Startup/reconcile, scans, kill/resume, daily-loss halt, post-flatten-time tick, shutdown, and a second engine startup create no orders, fills, or positions and invoke no broker mutation or account-read methods. The broker spy represents an account with existing MIS positions and a pending order. Jev and mock selection, both override values, and both restart policies are covered; evaluations use a local deterministic adapter.
4. No external broker/model service or full historical replay was exercised. Replay clock edge cases and accounting remain explicit Phase 1 prerequisites in units 5 and 11; Phase 0 completion certifies the audit and safe offline baseline, not replay correctness or a paper wallet.

## Phase 1 file-by-file sequence

Each unit ends in offline verification before the next unit begins. Paths below are proposed, not existing features.

| Unit | Files | Change and verification |
| --- | --- | --- |
| 1. Validated configuration | `src/config.ts`, `src/execution-policy.ts`, `.env.example`, `scripts/config.test.ts` | Parse finite limits; implement PAPER_INITIAL_CAPITAL=10000, PAPER_MAX_ORDER_VALUE=1000, PAPER_MAX_POSITIONS=3, PAPER_DAILY_LOSS_LIMIT=300; reject invalid values; keep live disabled |
| 2. Capability boundaries | `src/broker.ts`, `src/data/feed.ts`, `src/executor/types.ts` | Separate market-data reads from trading; add account/idempotency and explicit market/limit intent types; enforce whole-share long-only equity |
| 3. Additive storage | `src/db.ts`, new `src/portfolio/store.ts`, `src/portfolio/migrations.ts` | Inject SQLite connection; version migrations; add paper accounts, orders/events, fills, ledger/reservations, positions/trades with constraints and indexes; test existing DB upgrade without data loss |
| 4. Ledger and wallet | new `src/portfolio/ledger.ts`, `wallet.ts`, `positions.ts`, `scripts/wallet.test.ts` | Integer-paise postings, cash/share reservation, average cost and net realized/unrealized P&L; reconcile ledger and recovered views after restart |
| 5. Fee and quote policy | `src/costs.ts`, new `src/executor/fill-model.ts`, `scripts/fill-model.test.ts` | Effective-date fee estimates; explicit rounding, spread/slippage, freshness, marketability, resting limits; verify missing/stale quotes never fill |
| 6. Paper executor | new `src/executor/paper.ts`, `scripts/paper.test.ts` | Atomic submit/modify/cancel/expire/fill; full fills only; durable idempotency; test overspending, duplicates, rejection, pending price changes, share overselling, restart |
| 7. Mode selection | new `src/executor/observe.ts`, `src/executor/router.ts`; update `src/main.ts`, `src/engine.ts`, `src/executor/live.ts` | Choose executor once; observe creates no orders; paper receives no broker trading capability; remove paper reliance on legacy Engine.handleFill bookkeeping |
| 8. Risk integration | `src/risk.ts`, `src/engine.ts`, `src/strategy/continuation.ts`, `src/strategy/exits.ts` | Enforce paper order value, pending/open positions and realized/unrealized daily loss; reject shorts/options; stop-loss exit; test no model bypass |
| 9. Recovery and fixtures | new `src/data/fixtures.ts`; update `src/main.ts`, `src/engine.ts` | Offline fixture startup; restore paper state transactionally; verify recovery/kill/shutdown use only selected executor |
| 10. Manual API | `src/server.ts`, new `src/api/paper.ts`, `scripts/paper-api.test.ts` | Account/positions/orders/trades reads, create buy/sell, inspect/modify/cancel; validation, proper status codes, local access controls; verify complete open/close HTTP workflow |
| 11. Replay integrity | `src/replay/sim.ts`, `scripts/replay.ts`, `src/data/features.ts`, `scripts/replay.test.ts` | Completed-bar timing, next-eligible-bar fills, stop/target ambiguity, callback ordering; repeatable fixture tests without future bars/snapshots |
| 12. Acceptance | `scripts/safety.test.ts`, `scripts/smoke.ts`, package scripts and all four docs | Run full offline suite; zero broker mutations; persist/restart/open/close account; documented fill assumptions and reconciled cash/P&L |

Paper order submission must commit order/event and reservation together. A fill must commit order status, unique fill, ledger, position, and completed-trade updates together. Idempotency keys replay the prior result only for the identical request. A rejected mutation leaves the account unchanged. Tests must check observable balances and order behavior, not merely mirror implementation.

## Later phases

Phase 2 retains Jev behind the existing Model contract, validates output at the boundary, adds one coherent VWAP/momentum baseline, records strategy/model versions, and supports approval, cooldown, deduplication, scans, and automatic exits. Model/data failures mean no new orders.

Phase 3 builds the seven requested pages against working APIs. Phase 4 adds equity-based drawdown, exposure, return, expectancy, costs, profit factor, benchmarks, and out-of-sample evaluation with data provenance and historical-universe caveats. Phase 5 adds Docker, health endpoints, reconnect state, process supervision, backups, secrets, and authentication before remote access. No new infrastructure is justified yet.

Live mode is never a side effect of adding credentials or selecting a model. Phase 6 remains outside current authorization.
