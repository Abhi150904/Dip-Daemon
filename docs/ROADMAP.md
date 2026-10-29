# DipDaemon roadmap

Updated 29 October 2026. Phases 0–4 are delivered as local, offline-verified workflows on main. Live execution stays disabled. Strategy execution defaults off until explicitly enabled for paper trading.

## Phase status

| Phase | Status | Acceptance evidence |
| --- | --- | --- |
| 0: audit and foundation | Completed | Source audit/docs, native SQLite repair, type check, safety/lifecycle suite, deterministic smoke |
| 1: persistent paper trading | Completed (manual MVP) | Isolated wallet/executor, manual API buy/sell, fees/P&L, cash/share reservations, restart, fault rollback, risk exits, synthetic offline demo |
| 2: automated AI paper trading | Completed (offline verified) | Deterministic/validated AI signals, approval/automatic paper entry and exit, scheduler, ownership, cooldowns, audit trail and failure tests; real provider not exercised |
| 3: dashboard | Completed (local workflow) | Seven browser pages; manual orders/close/modify/cancel, signal approval and policy controls, journal, responsive QA and 57 passing tests; evaluation remains Phase 4 |
| 4: evaluation | Completed (offline workflow) | VWAP/session benchmark, recorded-AI archive replay, full-session/universe validation, isolated worker, saved runs, metrics and separate holdout; real historical provenance unverified |
| 5: reliability | Planned | Recoverable deployed service, health, backups, reconnect/monitoring, secrets and authentication |
| 6: optional live trading | Blocked | Explicit authorization and independent reconciliation, execution, operational and compliance review |

## Phase 0 record

The initial SQLite smoke test failed because its native binary was missing. Installing the official matching prebuilt binary and approving better-sqlite3/esbuild setup repaired it. The type check, safety tests, fixture Engine/SQLite lifecycle matrix and improved smoke passed. This established an offline baseline; it did not certify external broker APIs or historical replay correctness. The original MIT attribution remains unchanged.

## Phase 1 delivery by file

| Files | Delivered responsibility |
| --- | --- |
| `src/portfolio/types.ts`, `src/config.ts`, `src/execution-policy.ts`, `.env.example` | Validated paper limits, request types and money conversion; explicit paper opt-in; live disabled; loopback binding |
| `src/portfolio/wallet.ts` | Additive schema version 1, ledger-derived cash, durable reservations, foreign keys and order/fill uniqueness |
| `src/executor/paper.ts` | Full market/limit fills, modify/cancel/expire/reject, fresh quotes, spread/slippage, dated fee assumptions, atomic accounting, long-only positions, stops and risk exits |
| `src/api/paper.ts`, `src/server.ts` | Manual orders, account, positions, journal, events/ledger; input/status handling, local Host/origin and body-size checks; health/data endpoints |
| `src/main.ts`, `src/engine.ts` | Optional paper-service construction and tick, held/pending market-data subscriptions, clear mode/source; scanner remains observe-only |
| `scripts/paper-demo.ts` | Separate persistent synthetic account and virtual quotes, no broker/model network access |
| `scripts/paper.test.ts`, `scripts/safety.test.ts`, `package.json` | Accounting, limits, stale/missing data, reservations, duplicate requests, fault rollback, restart, protective exits, HTTP and process-level demo tests; broker guards in paper/observe |
| README and docs | Operation examples, API, money units, assumptions, limitations, architecture and validation record |

The first delivery uses an injected connection in the new paper store, rather than refactoring every inherited DB caller. Fee policy is separate from the inherited cost module. The shared PlaceIntent has a paper entry point with idempotency, while the old Executor.onFill callback is excluded from paper accounting. These choices keep legacy replay behavior stable and paper writes atomic.

The acceptance workflow is manual buy -> marked holding -> partial/full sell -> journal/account -> restart with identical persisted financial records. Paper fill policy accepts timestamped quote inputs only. Legacy candle replay is separate; its no-look-ahead, stop-limit and intrabar issues remain Phase 4 work, not certified Phase 1 capabilities.

Final validation: `pnpm typecheck`, all 30 `pnpm test` checks, and `pnpm smoke` pass. No external broker or model endpoint was exercised. The standalone synthetic demo was started and traded through the actual HTTP server in its own process.

Explicit MVP limits: one virtual account, whole-share full fills, no shorts/options/increases, no quantity modification, weekday hours without an exchange-holiday calendar, flat estimated fees rather than broker tax itemization. Missing/stale data blocks entries/fills and can prevent an exit; positions remain recorded rather than pretending they closed. Frontend order tickets are deferred; strategy entries are now available through Phase 2's separate opt-in service.

## Phase 2 delivery by file

| Files | Delivered responsibility |
| --- | --- |
| `src/strategy/signals.ts` | Validated automation configuration, typed decisions, completed-bar VWAP/momentum baseline |
| `src/model/validation.ts`, `src/model/jev.ts` | Required provider-answer validation, finite/range checks and identity recording; existing deadlines retained |
| `src/strategy/continuation.ts`, `exits.ts`, `ai-paper.ts` | Reused two-stage ranking/exit questions, validated results, model versions, existing AI gates and six-decimal composite scores |
| `src/automation/paper.ts` | Scheduled/manual scans, deadline/revision guards, approval/automatic execution, deterministic sizing/risk, cooldown/deduplication, ownership and transactional signal/order audit |
| `src/portfolio/wallet.ts`, `types.ts`, `src/executor/paper.ts` | Additive entry-order identity migration, shared quote preview and strategy order explanations; manual records preserved |
| `src/api/automation.ts`, `src/api/paper.ts`, `src/server.ts` | Local strategy/configuration/signal/run/event APIs using existing request protections |
| `src/config.ts`, `src/main.ts`, `src/engine.ts` | Strict model/startup automation selection and snapshot/service wiring; legacy scanner stays observe-only |
| `scripts/paper-demo.ts`, `automation.test.ts`, `paper.test.ts`, package scripts | Credential-free synthetic strategy operation, end-to-end API/demo and regression tests |
| `docs/AUTOMATION.md` and existing docs | Exact commands, defaults, rules, data assumptions and remaining verification limits |

The service owns decisions and orchestration; PaperExecutor remains authoritative for money and account limits. It never calls legacy Engine.handleFill or real broker trading methods. Schema version 2 preserves balances and legacy manual holdings; only positions linked to accepted automation buy signals are strategy-managed. Model/provider errors, invalid market context, expired approvals, timeout and stale configuration revisions produce no strategy orders.

The real Jev provider, current market data, profitability, historical evaluation, public hosting remain unverified. Phase 3 browser interaction is verified with synthetic data. The deterministic strategy and Jev adapter are exercised offline, including automatic and approved entry/exit. See [Automation](AUTOMATION.md).

Final Phase 2 verification on 29 October 2026: `pnpm typecheck`, all 54 `pnpm test` checks, `pnpm smoke` and `git diff --check` pass. No real order endpoint or model provider was called.

## Original Phase 2 implementation checklist

1. `src/model/jev.ts`, `src/model/index.ts`: validate provider output schemas, finite scores, declared versions, timeout/error no-order behavior.
2. New strategy signal types and deterministic VWAP/momentum module under `src/strategy/`: explicit rules and independently testable signals.
3. `src/strategy/continuation.ts`: retain two-stage ranking and emit the same structured signal contract, with rejection explanations.
4. `src/engine.ts`: route approved long-only signals into PaperExecutor.place, never Engine.handleFill or broker methods; keep observe signals order-free.
5. Paper signal/run persistence: strategy/model/parameter versions, signal -> risk -> order traceability, duplicate-signal suppression and cooldowns.
6. Approval and automatic-paper controls in the local API, disabled by default until selected explicitly; enforce deterministic paper risk regardless of model response.
7. Offline tests: model error/timeout, rejected/duplicate signal, approval, cooldown, automatic entry/monitor/exit, persistent audit trail and broker isolation.
8. Update documentation and mark Phase 2 complete only after the complete virtual strategy workflow is exercised.

Phase 3 connects the paper account, order ticket, signals/approval, strategy controls and journal to the browser. See [browser operation](DASHBOARD.md). Phase 4 expands replay integrity, benchmarks, portfolio equity metrics and out-of-sample evaluation. Phase 5 adds deployment safeguards before remote access. Phase 6 remains outside present authorization.

## Phase 4 delivery

`src/backtest/` validates immutable datasets, runs a causal next-open intraday evaluator and persists independent results. A bounded worker protects the running paper loop. `src/api/backtest.ts` provides local imports, cache capture and saved comparisons. `web/backtests.js` replaces the placeholder with configuration, separate in-sample/holdout results, equity/ledger views and JSON export. The existing completed-bar VWAP signal implementation is reused; legacy interactive replay is preserved but its candle-timing assumptions are not reused for evaluation.

See [evaluation operation and limitations](BACKTESTING.md). Real historical membership, adjustments and provider/model authenticity require independent evidence. Next is Phase 5 reliability; live trading remains outside authorization.
