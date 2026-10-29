# Use the browser paper workspace

Run this from the project folder:

```powershell
pnpm paper:demo
```

Open http://127.0.0.1:8080. No new `.env` values are needed. If an older process already uses port 8080, stop that process with Ctrl+C and restart the demo to load the new dashboard API. Refresh the browser after restarting.

The demo uses synthetic prices and a separate persistent virtual account in `data/paper-demo.db`. PAPER and SYNTHETIC-FIXTURES identify it. Its virtual clock is independent of real market time. Ordinary `pnpm start` remains observe mode unless configured for paper trading.

## Try a complete trade

1. Open **Paper Trading**. Leave INFY, Buy, 1 share and Market selected. Click **Place paper buy**. Expect a filled order and an open position.
2. Click **Close 1 shares** beside the position and confirm. Expect a sell order and a closed position.
3. Open **Trade Journal**. Check the entry and exit times, per-share prices, combined costs and net P&L. Expand **Trade reasons** for the entry explanation and exit reason.
4. Place an INFY limit buy below the current quote, such as ₹90. Expect an open order and reserved cash. Expand **Modify limit**, save ₹91, then **Cancel**. Cancellation releases the reservation.

The account strip converts the backend's paise to INR. Unavailable/stale values appear as a dash rather than zero. Buy/sell fills include estimated costs, spread and slippage, so a round trip can lose money even near an unchanged price.

## Review or automate signals

1. Open **Strategies**. Select **VWAP momentum** and **Approval required**, then **Save policy**.
2. Click **Scan market**. Expand a decision for its strategy/model version, quote time, expiry, entry and stop.
3. Approve or reject a pending signal. Approved signals still pass current quote, drift, expiry and account risk checks. A rejection shows its backend reason; refresh/rescan after conditions change. Scans can correctly produce only HOLD decisions.
4. Select **Automatic paper orders**, save and confirm to allow eligible virtual orders without individual approval. **Pause automation** returns the policy to Off. Changing configuration expires pending approvals.

Account stops remain active independently of automation policy. **Emergency stop** on Overview cancels open buys, blocks new entries and attempts to flatten paper positions when fresh quotes and trading hours permit. Clearing it does not reset a daily loss halt.

## Find information

- **Overview:** account values, cumulative closed-trade net result, positions, risk and recent decisions.
- **Market Scanner:** configured Nifty 50 universe, quotes, changes, volume, ATR, relative volume, latest signal score and reasons. Rank is by latest recorded signal score among quoted symbols; it is not a validated performance ranking. Search a symbol and choose **Trade** to prefill the ticket.
- **Settings:** account limits, provider/model identity, scan frequency, strategy risk parameters and audit details. Account limits and credentials remain server configuration. The browser never receives credentials.
- **Backtesting:** Phase 4 status and recorded session dates. Historical evaluation, comparisons and performance metrics are not implemented. Use **Legacy dashboard & replay** for the existing replay tools.

Polling refreshes every three seconds while the tab is visible. It preserves an active ticket, edited configuration and focused table controls. Connection failure retains the last snapshot and disables actions until a successful refresh. If a submission response is interrupted, refresh and retry the unchanged ticket: its idempotency key is retained for the current page session. Reloading the page discards that key, so inspect order history before placing another order after a reload.

## Verification

Phase 3 adds no frontend dependency or separate build. The local Node server serves native browser modules and an authoritative `/api/dashboard` snapshot. Legacy assets stay separate at `/legacy.html`.

`pnpm typecheck`, `pnpm test` (57 checks), `pnpm smoke` and browser checks cover the manual workflow, limit changes, approvals/rejections, automatic-policy confirmation, pause, settings save, emergency-stop status, scanner handoff and responsive routes. API tests cover same-origin protection, observe-mode account isolation, snapshot/account equality and asset delivery. Formatting tests distinguish unknown marks from zero, convert paise once and escape server text.

Real broker/model providers and historical strategy performance were not exercised. Real orders remain disabled.
