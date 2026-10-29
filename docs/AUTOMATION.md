# Try strategy-driven paper trading

Phase 2 adds a deterministic VWAP/momentum strategy, a validated Jev adapter, approval and automatic paper modes, scheduling, cooldowns and a persistent decision trail. The service submits only to PaperExecutor. Both real broker clients still reject every order mutation.

## Start without credentials

Stop the previous demo process with Ctrl+C and start the updated version:

```powershell
pnpm paper:demo
```

No `.env` changes are needed. Existing virtual cash and trades remain in `data/paper-demo.db`. Startup adds completed synthetic candles for the strategy and retains the explicitly synthetic quote source. The virtual session remains a demonstration dated 26 October 2026, not current market data. Automation starts off on every demo launch.

In a second PowerShell terminal, enable approval mode and scan:

```powershell
$base = 'http://127.0.0.1:8080'
$config = @{ mode = 'approval'; strategy = 'vwap_momentum' } | ConvertTo-Json
Invoke-RestMethod "$base/api/automation/config" -Method Post -ContentType 'application/json' -Body $config
Invoke-RestMethod "$base/api/automation/scan" -Method Post
$signals = Invoke-RestMethod "$base/api/signals"
$signals | Select-Object id, symbol, action, status, reason
```

Approve one pending buy, then inspect the resulting paper position:

```powershell
$pending = $signals | Where-Object { $_.status -eq 'pending' -and $_.action -eq 'BUY' } | Select-Object -First 1
if ($pending) {
  Invoke-RestMethod "$base/api/signals/$($pending.id)/approve" -Method Post
}
Invoke-RestMethod "$base/api/paper/positions"
Invoke-RestMethod "$base/api/paper/account"
```

Approvals expire after 60 seconds by default. The executor rechecks fresh prices, price drift, stop distance, available cash, position count, daily halt, kill and cooldown. A high score does not override these checks. If no pending buy exists, inspect signals and runs rather than repeatedly submitting a rejected decision. Synthetic price movement, previous trades and risk limits can prevent an entry.

For autonomous paper entries and strategy exits, select automatic mode:

```powershell
$config = @{ mode = 'automatic'; strategy = 'vwap_momentum' } | ConvertTo-Json
Invoke-RestMethod "$base/api/automation/config" -Method Post -ContentType 'application/json' -Body $config
Invoke-RestMethod "$base/api/automation/status"
```

The scheduler checks during the virtual session every 30 seconds. Configuration changes invalidate pending approvals. A decision already recorded for the same completed bar is not resubmitted after a mode change, so a new opportunity may require the next completed minute. There is no promise of a trade on every scan. Recent manual closes also count toward the per-symbol cooldown.

Inspect decisions, paper trades and the audit trail:

```powershell
Invoke-RestMethod "$base/api/signals"
Invoke-RestMethod "$base/api/automation/runs"
Invoke-RestMethod "$base/api/automation/events"
Invoke-RestMethod "$base/api/paper/trades"
```

To pause strategy execution:

```powershell
Invoke-RestMethod "$base/api/automation/config" -Method Post -ContentType 'application/json' -Body '{"mode":"off"}'
```

Off pauses strategy entries and exits, expires pending approvals and cancels pending strategy buy orders. Existing paper stops, kill, daily-loss and session protection remain active while the process runs. It does not close positions merely because automation was turned off.

## Modes and restart behavior

| Mode | Behavior |
| --- | --- |
| `off` | No scheduled scans or strategy orders. A manual scan records observed signals only. |
| `approval` | Scheduled scans record pending actionable signals. Each entry or strategy exit requires its own approval. Protective paper exits do not require approval. |
| `automatic` | Valid actionable signals submit paper orders after deterministic risk checks. |

The current configuration revision and every run's parameters are stored. API-selected execution mode resets to off at ordinary restart unless startup environment explicitly opts in. Old pending approvals expire and unfinished runs become interrupted. Paper balances, ownership, trades, deduplication keys and cooldowns survive. The demo always starts off and uses the deterministic strategy regardless of startup environment.

Ordinary `pnpm start` can read these optional `.env` additions after market-data paper mode is configured:

```dotenv
TRADING_MODE=paper
PAPER_AUTOMATION_MODE=approval
PAPER_STRATEGY=vwap_momentum
```

Use `automatic` only for an explicit persistent simulated-execution opt-in. Nothing here enables real orders. Observe-only startup can collect signals through manual scans, but rejects execution-mode enablement without a paper account.

## Strategy rules

The baseline `vwap-momentum-v1` uses only completed one-minute bars from the same IST date. It requires at least 20 recent, positive-volume, contiguous candles; the latest completed candle must be no more than two minutes old. Incomplete and future bars are excluded.

A buy requires all of these conditions:

- Last completed close above session VWAP, computed from typical price and volume.
- Last completed close at least 5 basis points above the close three bars earlier.
- Latest completed-bar volume at least 1.2 times the mean of the preceding 10 bars.
- VWAP extension no greater than 200 basis points.
- Stop distance of 1.5 times 14-bar ATR, floored at 10 basis points, no greater than the configured 100-basis-point cap.

Score is bounded between zero and one, starting at 0.6 with bounded momentum/volume contributions. Default minimum is 0.6. Entry price and whole-share sizing are computed from the paper executor's current executable-price estimate and virtual budget. Stops round down to paise. Thresholds and versions describe research rules, not an assertion of profitability.

For an automation-owned holding, the baseline exits on completed-bar VWAP breakdown, three-bar momentum at or below negative 5 basis points, or the maximum holding time of 30 minutes. PaperExecutor independently handles attached stops and account protection. Manual positions are not strategy-managed, even when automation is enabled. Schema version 2 adds the entry-order identity; legacy holdings with unknown identity remain manual.

Signals are deduplicated by strategy/version, model identity, symbol, action and completed-bar timestamp. Default cooldown is five minutes after strategy order acceptance and after the most recent close of that symbol. Exits are considered before buys, then buys rank by score. Signal-specific order idempotency and an immediate shared SQLite transaction keep accounting and signal links consistent.

## Jev adapter

The `jev` strategy retains existing stage-one regime/universe ranking and stage-two long continuation validation. It requires actual `MODEL=jev` selection, valid stock features, completed candles and fresh index data. Existing spread, relative volume, news/event and risk-off gates remain active. Model position questions can generate exits for automation-owned holdings; the deterministic holding-time limit also applies when the evaluation is valid.

Provider responses must include requested answers. Probabilities/confidence must be finite and within zero to one; choice labels must match declared criteria; probability distributions must cover criteria and sum to one within 0.02; scores must lie within their criterion range. Numeric strings, NaN/Infinity, missing answers and contradictory answer types are rejected. Composite scores round to six decimal places before threshold comparisons. Missing model confidence causes the existing confidence gate to reject a candidate.

A whole-scan deadline defaults to 10 seconds in addition to Jev's existing request deadline. Any provider error, invalid stage, unavailable data or timeout produces a failed run and no strategy orders for that scan. Late results and results from an old configuration revision cannot execute. Protective PaperExecutor exits remain independent of AI availability.

The real Jev provider has not been called during verification. Tests use a deterministic local model with the same question/answer contract. Provider-reported IDs or aliases are recorded as modelVersion; they are not proof of immutable model weights. Real provider availability/response compatibility requires a separate configured read-only check. The demo cannot call Jev and will fail a Jev scan rather than silently substitute a mock provider.

## API and configurable parameters

All strategy endpoints use the same local Host/origin and bounded-JSON protections as paper endpoints. Malformed configuration returns 400; unavailable service or concurrent scan returns 409; missing signal returns 404; execution rejection returns 422. A scan request returns 200 with its run status, which can be failed. Always inspect status/reason rather than treating HTTP 200 as a trade fill.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/strategies` | Available versions and current strategy configuration |
| GET | `/api/signals` | Latest 200 decisions and their payloads/status/order links |
| GET | `/api/automation/status` | Mode, revision, scan state and effective execution environment |
| GET | `/api/automation/runs` | Latest 100 run parameters, times, status and failures |
| GET | `/api/automation/events` | Latest 200 generation/risk/approval/order events |
| POST | `/api/automation/config` | Update validated strategy parameters; invalidate pending approvals |
| POST | `/api/automation/scan` | Request a scan now, including an observe-only scan when off |
| POST | `/api/signals/:id/approve` | Revalidate and submit one pending paper action |
| POST | `/api/signals/:id/reject` | Reject one pending action |

Configurable JSON fields are mode, strategy, scanIntervalS (30), cooldownS (300), signalTtlS (60), modelTimeoutMs (10000), minScore (0.6), momentumBps (5), minVolumeRatio (1.2), stopAtrMult (1.5), maxStopBps (100), maxPriceDriftBps (50) and maxHoldMinutes (30). Unknown fields and out-of-range/nonfinite values fail validation. The Phase 1 account limits still apply independently.

Each signal records symbol, action, score, explanation, strategy/version, provider/deterministic model identity, quote time, completed-bar time, generation time, expiry and actionable entry/stop prices. The generation event also records data-source label, configuration revision and a SHA-256 snapshot fingerprint. The fingerprint is an audit reference, not a replacement for a historical input archive. Risk and order events link through signal IDs to paper orders, fills, ledger, positions and completed trades.

## Verification and limits

```powershell
pnpm typecheck
pnpm test
pnpm smoke
```

The suite covers deterministic entry/exit, AI contract validation, approval and automatic modes, expiry, drift/stop checks, cooldown/deduplication, stale data/index, model failures/timeouts/late results, policy changes in flight, manual-position isolation, additive migration, restart, transaction fault injection, scheduler timing and actual localhost control APIs. The standalone synthetic demo is also booted and traded by the tests.

Validated on 29 October 2026: type check, all 54 suite checks, deterministic smoke and Git whitespace checks pass. If the initial run cannot be persisted, the API returns 503 without placing orders and releases the scan guard so a later retry can succeed.

The same Phase 1 assumptions remain: weekday hours without an exchange holiday calendar, receipt-time quote timestamps, full fills without liquidity modeling and estimated fees. This phase does not certify real broker/model APIs, live execution, historical replay integrity, strategy profitability, multiuser access or a frontend order interface. Phase 3 adds the dashboard workflow.
