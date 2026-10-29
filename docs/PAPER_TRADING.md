# Operate the paper account

Phase 1 provides a local backend for manual, long-only NSE cash-equity simulation. All monetary values in responses are **integer paise**; order input prices and environment capital values are **rupees**. No broker trading endpoint is used. Phase 2 adds opt-in [strategy automation](AUTOMATION.md); the frontend ticket remains Phase 3 work.

## Try synthetic quotes without credentials

Run this in the project directory:

```powershell
pnpm paper:demo
```

This command serves the existing dashboard and paper APIs on `127.0.0.1:8080`. It generates explicitly synthetic INFY, TCS, and RELIANCE quotes on a virtual weekday session beginning 26 October 2026 at 09:45 IST. It never fetches broker or model services. Records persist in `data/paper-demo.db`, independently of the normal account. The kill file is `data/paper-demo.db.kill`. The virtual clock advances two seconds every two real seconds. Prices repeat a synthetic sequence; this is a workflow demo, not a backtest or market prediction.

Use a second PowerShell window for orders:

```powershell
$base = 'http://127.0.0.1:8080'
Invoke-RestMethod "$base/api/market/status"
Invoke-RestMethod "$base/api/market/stocks"
Invoke-RestMethod "$base/api/paper/account"

$buy = @{
  idempotencyKey = [guid]::NewGuid().ToString()
  symbol = 'INFY'
  side = 'buy'
  qty = 2
  type = 'market'
  stopLoss = 98
} | ConvertTo-Json
Invoke-RestMethod "$base/api/paper/orders" -Method Post -ContentType 'application/json' -Body $buy
Invoke-RestMethod "$base/api/paper/positions"

$sell = @{
  idempotencyKey = [guid]::NewGuid().ToString()
  symbol = 'INFY'
  side = 'sell'
  qty = 2
  type = 'market'
} | ConvertTo-Json
Invoke-RestMethod "$base/api/paper/orders" -Method Post -ContentType 'application/json' -Body $sell
Invoke-RestMethod "$base/api/paper/trades"
Invoke-RestMethod "$base/api/paper/account"
```

A stop may already have closed the position before the manual sell. Inspect positions before retrying. A retry of the identical request must keep its original idempotency key. A new key is a new order. Reusing a key with different inputs returns 409; retrying a rejected request returns its original rejection.

For a limit, use `type='limit'` and `limitPrice=99` instead of market type. Limits can remain open until a later eligible quote, cancellation, a risk halt, or session expiry. A buy limit reserves its full limit notional plus estimated fees. A pending sell reserves shares.

Stop the demo with Ctrl+C. Restarting preserves cash, pending orders, positions, trades, and loss halts. `PAPER_DEMO_DB_PATH` selects a separate demo file when needed. Changing initial-capital configuration never resets an existing account. There is deliberately no reset-money API.

## Use configured broker data

Set these values in `.env`, alongside broker market-data credentials:

```dotenv
TRADING_MODE=paper
HOST=127.0.0.1
PAPER_INITIAL_CAPITAL=10000
PAPER_MAX_ORDER_VALUE=1000
PAPER_MAX_POSITIONS=3
PAPER_DAILY_LOSS_LIMIT=300
PAPER_QUOTE_MAX_AGE_MS=15000
PAPER_SLIPPAGE_BPS=2
PAPER_FALLBACK_SPREAD_BPS=5
PAPER_FEE_BPS=5
PAPER_FEE_EFFECTIVE_FROM=2026-01-01
```

Run `pnpm start`. The inherited scanner reads broker quotes and generates observe-only decisions. Manual orders and the separately controlled Phase 2 strategy service use that quote map. Paper positions and pending orders add their symbols to the feed's active token list. No broker order, cancel, modify, margin, or position-recovery call is needed for paper accounting. Market-data/login requests still require the configured broker and can fail independently of the paper ledger.

Without broker data, ordinary startup keeps an empty session and paper orders are rejected for missing quotes. Use `paper:demo` for the explicit offline fixture workflow. Stale or unavailable data must never become a successful fill. The old dashboard displays the execution mode, but its inherited position panels remain strategy-engine views; use paper endpoints for authoritative paper-account records until Phase 3.

## API reference

All endpoints return JSON. Paper APIs require an accepted Host and same-origin browser requests; without authentication they also require loopback access. JSON bodies are limited to 16 KiB. Non-loopback startup requires authentication and an exact origin. This remains a single shared account; see [deployment](DEPLOYMENT.md).

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/health` | Process status and execution mode |
| GET | `/api/market/status` | Data connection and broker/synthetic source label |
| GET | `/api/market/stocks` | Currently cached timestamped quotes, including potentially stale snapshots |
| GET | `/api/paper/account` | Cash, reserved/available cash, cost, marked value, equity, realized/unrealized P&L, fees, daily loss status |
| GET | `/api/paper/positions` | Positions, average entry, reserved/free shares, marks and P&L |
| GET | `/api/paper/orders` | Open and terminal orders |
| GET | `/api/paper/orders/:id` | One order |
| POST | `/api/paper/orders` | Submit buy/sell with idempotencyKey, symbol, side, qty, type, optional limitPrice and buy stopLoss |
| POST | `/api/paper/orders/:id/cancel` | Cancel pending order and release reservations |
| POST | `/api/paper/orders/:id/modify` | Change an open limit price using `{ "limitPrice": 99 }`; quantity changes are unsupported |
| GET | `/api/paper/trades` | Completed sale lots and net P&L |
| GET | `/api/paper/events` | Latest 200 order events |
| GET | `/api/paper/ledger` | Cash postings and fee amounts |

Malformed requests return 400, missing IDs 404, conflicting requests/states or inactive paper service 409, oversized JSON 413, unsupported content type 415, and risk/data rejections 422. A risk-rejected valid order is persisted with its explanation. Invalid request shapes are rejected before creating an order. Unexpected storage failures roll back the transaction and return 500. Successful create/retry returns 200, with `status` showing whether the order filled or remains open. Paper account APIs return 409 in observe-only service instances.

## Fill and risk assumptions

- Only positive whole-share, long-only cash-equity orders are supported. Position increases are rejected; partial sells are supported. Options, shorts, partial fills, quantity modification, and stop-limit order tickets are not supported.
- Fills are full quantity, without depth/liquidity modeling. Market buys use ask plus slippage; sells use bid minus slippage. Prices round adversely to the quote's tick. If both bid and ask are absent, a configurable estimated spread is applied around LTP before slippage. Crossed or incomplete books are rejected.
- A marketable limit uses the same executable price and never exceeds its limit. A resting limit waits for a subsequent eligible quote. Modifications require a quote at or after modification for a later fill. Quotes must have matching symbols, positive finite prices/ticks, a nonfuture timestamp, and age within the configured maximum. A fresh cached quote may be used immediately on submission, with its original timestamp recorded in the fill.
- Broker client timestamps currently represent receipt time, not a certified exchange trade timestamp. Snapshot freshness cannot establish underlying trade liquidity. Fills identify whether bid/ask or estimated-spread fallback was used.
- `PAPER_MAX_ORDER_VALUE` caps buy notional; closing sells are allowed above that cap to reduce exposure. Fees reserve additional cash. Pending buys count toward the position cap. Pending sells reserve shares. Available cash cannot be negative.
- Stops trigger when fresh bid (or fallback LTP) reaches the position stop and execute as simulated market sells, including adverse gaps. Stops and kill/loss/session exits supersede resting sell orders. If data is stale, the position remains open and equity/P&L are reported unavailable rather than inventing a fill.
- Entries and fills use a weekday 09:15–15:30 IST session. New buys stop at 15:10; tick requests flatten from 15:10 using valid data. DAY orders expire at close or on the next observed date. Public-holiday calendars and broker early closes are not implemented.
- Daily loss uses a persisted baseline at the first valid account valuation of each IST date. For positions carried because prices were unavailable, the baseline is their first valid next-day mark. A halt is durable until the next date; kill/resume and process restarts do not reset it. A risk halt cancels pending buys and attempts valid-price exits on ticks.
- The fee model is `research-flat-v1`: configurable flat basis points per fill, rounded up to paise, effective from the configured date. It is a combined research estimate, not an itemized or certified Indian tax/brokerage tariff. Slippage changes fill price and is separate from the fee posting. Each fill stores the model version, parameters, source, quote timestamp, and cost assumption date. Dates before the effective date cannot fill.
- Cash, order, fill, ledger, position, and trade writes commit atomically. Partial-sale cost and entry fees allocate proportionally in integer paise; the final sale receives the rounding remainder. Existing account funding survives configuration changes. Paper records use `paper_*` tables and never reinterpret legacy live/replay records.

## Verify

```powershell
pnpm typecheck
pnpm test
pnpm smoke
```

Tests use real SQLite, deterministic quotes, a fixed virtual clock, fault injection, disk reopen, HTTP requests, and a standalone synthetic demo. HTTP tests require localhost access. No real broker/model service is contacted. Legacy historical SimExecutor is unchanged and is not routed through the new paper account. Its no-look-ahead/intrabar limitations remain tracked for the evaluation phase. The current paper fill policy accepts quote inputs only; do not pass candle OHLC as fresh executable quotes.
