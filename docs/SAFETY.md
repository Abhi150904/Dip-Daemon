# Execution safety and validation

Audit date: 26 October 2026. No real broker order endpoint was called. Broker/model credentials were not requested or read from private files. Runtime checks used fixtures or client methods intercepted before network access.

## Immediate inherited risks

| Finding | Evidence | Phase 0 treatment |
| --- | --- | --- |
| Model selection authorized live execution | Engine constructor used Jev or ALLOW_MOCK_TRADING to set canTrade; default executor was LiveExecutor | Normal engine canTrade is now false regardless of model or credentials |
| Startup recovery bypassed entry guards | Engine.reconcile directly cancelled unknown orders, flattened MIS positions, or placed protection after adoption | Observe and replay skip real-account reconciliation |
| Kill, daily loss, and session flatten could mutate orders | Engine fastLoop/checkKill -> executor cancellation and exits | Both real clients reject mutations unconditionally; observe lifecycle spy matrix now passes |
| Invalid configuration could silently fall back or produce NaN | Broker/model fallback and numeric parsing in config.ts | Trading mode is validated now; full numeric/risk validation is pending |
| Account API controls lack authentication | server.ts accepts kill/resume, capital/wild and replay operations | Keep loopback only; access control required before remote exposure |
| Cached quotes can remain indefinitely | LiveFeed retains earlier quotes; entry/fill paths lack consistent freshness gates | Documented; freshness is a Phase 1 acceptance requirement |

## Mutation inventory

These are the real order-changing network paths found in the source. Both clients now call `blockLiveOrder()` before session setup, throttling, or request dispatch.

| Client method | Network operation in preserved source |
| --- | --- |
| KotakClient.place | POST `/quick/order/rule/ms/place` |
| KotakClient.modify | POST `/quick/order/vr/modify` |
| KotakClient.cancel | POST `/quick/order/cancel` |
| ZerodhaClient.place | POST `/orders/regular` |
| ZerodhaClient.modify | PUT `/orders/regular/:id` |
| ZerodhaClient.cancel | DELETE `/orders/regular/:id` |

LiveExecutor calls these methods for normal execution, stops, requotes, and cancellation. Engine.reconcile also directly calls place/cancel. Startup, kill, daily halt, scheduled flatten, and position management are therefore in the execution audit scope. Shutdown currently closes a session record and main immediately exits; it does not await pending work or close the HTTP server/database. No automatic broker flatten is added.

Other network operations include broker login/token exchange, instrument dumps, quotes, history, margin estimation, order/position reads, AI gateway/direct Jev, RSS, and optional Telegram alerts. They do not place orders, but commands that use them are not offline tests. Replay may fetch missing broker candles and call Jev. Probe and calibration were not run.

## Current execution policy

- Missing TRADING_MODE defaults to observe, including when broker credentials exist.
- Empty, misspelled, or unknown modes throw. Paper is an explicit virtual-account opt-in; live still throws. Paper settings are validated and non-loopback paper startup is rejected.
- ALLOW_MOCK_TRADING remains parsed for inherited compatibility but has no execution authority.
- Replay requires an explicitly supplied executor. Real client mutation blocks remain active even if a caller incorrectly injects a live executor.
- Observe does not reconcile, adopt, cancel, or flatten broker positions. This application is not protection for an existing real position.
- The existing live implementation is preserved, but no environment opt-in can enable its broker mutations in this phase.

## Accounting and research limitations

The inherited SQLite tables initialize on import, without wallet transactions. Legacy fill callbacks are asynchronous and their order/fill/position updates can diverge after a crash. Phase 1 avoids that callback path: separate paper tables use integer-paise ledger accounting, immediate transactions, idempotency keys, unique fills and persistent reservations. Legacy REAL-valued records are not treated as a paper account.

Cost constants are inherited, unversioned estimates, omit brokerage, and are not verified against current tariffs. Slippage is in some friction estimates but not replay fill prices. No current regulatory, tariff, historical-universe, or profitability claim is made by this audit. External verification belongs to later fee design and live compliance work.

Replay has next-bar order eligibility and a bounded historical bar query. Initial candle visibility, snapshot upper bounds, stop-limit gaps, intrabar ambiguity, future universe membership, and fill callback ordering still need tests. Existing maximum drawdown is based on completed trade P&L rather than a marked portfolio equity series. Report profit factor uses a denominator fallback when there are no losses. Existing metrics must not be treated as complete strategy evaluation.

HTTP controls lack authentication, origin enforcement, and bounded request bodies. Static-file resolution also needs containment review. Do not expose the server publicly or assume a private network alone provides authorization. Original service paths remain inherited; deployment reliability is unverified.

## Baseline results

Environment: Windows x64, Node v22.20.0, pnpm 12.15.0, strict TypeScript configuration. Existing installed dependencies were used; no dependency was added.

| Check | Result |
| --- | --- |
| Initial `pnpm typecheck` | Passed (`tsc --noEmit`) |
| Initial `pnpm smoke` | Failed: better-sqlite3 12.11.1 has no native binding for this installation; pipeline did not execute |
| `pnpm rebuild better-sqlite3` | Failed during pnpm supply-chain metadata verification: registry.npmjs.org DNS resolution unavailable; did not repair the native module |
| Subsequent pnpm checks | Metadata verification stalled; interrupted and used installed tools directly |
| `node node_modules/typescript/bin/tsc --noEmit` after safeguards | Passed |
| Initial `node node_modules/tsx/dist/cli.mjs --test scripts/safety.test.ts` | Passed: 2 test cases, including all six actual client mutation methods and zero fetch calls |
| Native repair: `node ../prebuild-install/bin.js --verbose` in the installed better-sqlite3 directory | Passed: official GitHub release v12.11.1, Node ABI 127, Windows x64 binary downloaded and loaded |
| Final `pnpm typecheck` | Passed |
| Final `pnpm test:safety` | Passed: 11 tests including eight observe lifecycle combinations; no external fetch calls or broker mutations |
| Final `pnpm smoke` | Passed: RELIANCE candidate, 69 whole shares within fixture capital, expected governor state; no order placed |

The mode test checks the missing default, supported observe mode, rejection of paper/live, and empty/unknown/case-mismatched values. The client test sets Jev and the legacy override, creates both real clients without login, spies on fetch, and checks place/modify/cancel rejection. It does not require SQLite.

The original smoke failure also triggered a second import error from its finally cleanup. Cleanup now closes only a successfully opened database. `pnpm-workspace.yaml` now explicitly approves builds for better-sqlite3 and esbuild; subsequent pnpm setup completed both install scripts. No storage implementation or dependency version was substituted.

`scripts/lifecycle.test.ts` exercises the actual Engine and SQLite with local candle/quote fixtures and a broker spy representing an existing MIS position and pending order. It covers mock/Jev selection, both legacy override values, and adopt/flatten policies. A deterministic local adapter preserves the selected model name without contacting Jev. Each scenario reaches the observe entry path, persists decisions, checks kill/resume, triggers daily-loss halt, ticks after scheduled flatten, shuts down, and starts a second engine. Assertions require zero broker account reads/mutations, zero external fetch calls, and no orders, fills, or positions created. Scratch database handles are closed before cleanup.

During test development, the first fixtures failed the strategy gates (excessive VWAP extension), and an assertion on lastSkipReason failed because the inherited WILD branch clears that display field after selecting candidates. Fixtures now describe a valid continuation, and tests assert the persisted observe event and selected candidate. The WILD display limitation remains; it does not authorize orders. The smoke fixture previously allowed zero size without failing; it now requires valid nonzero whole-share sizing and capital bounds.

Phase 0 is Completed: source audit, documentation, narrow safety guards, native repair, and offline runtime baseline are verified. Phase 1 manual paper-account delivery is described below. Not verified: dashboard/browser interaction, complete historical replay, external broker/model APIs, and production deployment. Existing real positions remain outside this application's management.

## Phase 1 validation and limits

The paper service has no broker reference and never calls legacy Engine.handleFill. Ledger postings, order status, fill identity, position cost and completed-trade accounting commit together. A triggered SQLite failure is tested to roll back all financial writes. Disk-reopen tests preserve reservations and account funding, apply one fill per order, close a recovered position, and recover completed trades without a second deposit.

The suite covers market/limit orders, insufficient funds, quantity and order-value validation, pending price changes, modifications/cancellation, reserved shares, position caps, idempotency conflicts, stale/future/crossed data, fees/spread/slippage, stops, daily halts, kill, session flatten/expiry, and the shared PlaceIntent adapter. Both actual broker clients reject place/modify/cancel under observe and paper settings with zero fetch calls. Local HTTP tests execute buy/sell/account/journal requests and verify malformed inputs, missing orders, cross-origin mutation and oversized body responses. A separate offline demo process is booted and traded through HTTP, then stopped and its temporary database removed.

Initial HTTP execution required localhost permission in the restricted runner. The first standalone demo test used the tsx CLI launcher and hit a Windows database lock during cleanup; the test now launches the actual Node server with `--import tsx`, waits for process exit, and releases the file. No real broker/model endpoint was used. Full verification commands are `pnpm typecheck`, `pnpm test`, and `pnpm smoke`.

Final Phase 1 results on 26 October 2026: `pnpm typecheck` passed; `pnpm test` passed all 30 tests (22 top-level cases plus eight lifecycle subtests); `pnpm smoke` passed with the expected fixture candidate and whole-share size. `git diff --check` passed. The manual account/API, persistent restart, atomic rollback, and standalone synthetic demo acceptance checks all ran successfully.

Paper weekday session checks do not include holidays. Full fills do not model liquidity or partial executions. Fee model research-flat-v1 is a dated combined estimate, not certified brokerage/tax itemization. Quote timestamps from inherited clients represent receipt time. Stale position marks make current equity/P&L unavailable; unfillable protective exits remain open exposure. The first valid valuation each IST date sets the durable daily equity baseline. A position carried because prices were unavailable uses the first valid next-day mark for that day's baseline. Account reset, multiuser authentication, full paper frontend and historical replay integration remain unimplemented. Phase 2 now adds explicitly controlled strategy entries/exits.

Paper APIs enforce loopback remote address, local Host, browser Origin and a 16 KiB JSON limit. Paper mode also applies the local request guard to inherited mutation controls and rejects non-loopback HOST configuration. The synthetic demo blocks outgoing fetch entirely and labels its market source; it uses a separate persistent account. These controls support local development, not public deployment.

## Phase 2 safety and verification

Delivered 29 October 2026: strategy execution defaults off. Approval and automatic modes call only PaperExecutor.place; the automation service has no broker reference. Its SQLite connection must be the same as the paper store's, so signal/order/audit writes share an immediate transaction. A triggered audit-storage failure is tested to roll back the order, fill, ledger, position and signal link together, leaving the approval pending for a safe retry.

Schema version 2 additively adds entry_order_id. Existing balances and manual positions remain unchanged. Strategy exits act only on positions owned by accepted automation buy signals; legacy/manual holdings are not adopted. Both actual broker clients still reject all trading mutations under paper and observe settings. The legacy engine scanner's execution remains observe-only.

Required model answers, finite values, score/probability ranges, declared choices/distributions and model identities are validated before use. MODEL selection is exact rather than a substring match. AI strategy risk thresholds used from risk.json are checked before evaluation. Invalid stages, errors, absent/stale index or stock data, deadline expiry and late results do not create strategy orders. API policy changes invalidate pending approvals and discard in-flight scan results.

Approvals recheck signal age, current executable quote, price drift, stop distance, cash/fees, position cap, cooldown and durable loss/kill status. Generated events store strategy/model versions, explanation, data source and snapshot fingerprint. Every submitted intent has a signal-specific idempotency key. Duplicate decisions on the same completed bar are suppressed across restarts; API-enabled execution resets off on restart unless ordinary startup environment explicitly opts in. The demo always starts off and blocks external fetches.

The first offline AI entry test exposed binary floating-point composite 0.5999999999999999 versus the 0.6 threshold. Six-decimal rounding in the shared scoring function now produces deterministic threshold behavior. Tests retain the score-boundary scenario. Other scenarios include completed-bar filtering, autonomous and approved entry/exit, maximum holding time, symbol cooldown, manual-position isolation, stale/expired approvals, account limits, model throw/invalid/missing/timeout/late responses, policy changes, restart, additive migration, scheduler intervals and localhost control APIs. A standalone demo process verifies deterministic automatic entries in addition to the manual workflow.

Verification uses real SQLite, local fixtures, fault injection and a model adapter with provider-shaped answers. No real Jev or broker endpoint is called. Provider compatibility/availability, live market conditions, strategy performance, holiday handling, full historical replay, frontend interaction and public deployment remain unverified. Provider-reported model IDs may be aliases rather than immutable weight versions. A snapshot fingerprint is an audit reference, not a complete historical archive. Existing paper fill/cost limitations remain.

Final results on 29 October 2026: `pnpm typecheck` passed, `pnpm test` passed all 54 checks (46 top-level cases and eight lifecycle subtests), `pnpm smoke` passed, and `git diff --check` passed. This includes initial-run storage-failure recovery, audit/order rollback, automated and approved virtual entry/exit, and the actual standalone synthetic demo process. Private `.env` was not edited; deleted `.env.example` was not recreated. All work remains on main without an agent commit or push.

## Git and attribution

The checkout began on an unborn main branch with every application file untracked. At the user's request, work continues directly on `main`. No existing files were deleted from Git history, no commit or push was made, and the original MIT license/copyright is unchanged. The audit does not claim provenance against an upstream commit that is absent locally.
