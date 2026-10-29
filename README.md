# DipDaemon

**Scan. Simulate. Trade.**

DipDaemon is an NSE trading research platform derived from [WarrenDuffer](https://github.com/arimanyus/warrenduffer). Its inherited TypeScript engine combines market features, Jev ranking, deterministic risk gates, SQLite records, historical replay, and a local dashboard.

Phases 0–4 provide safety controls, persistent paper trading, strategy automation, a browser workspace and repeatable local strategy evaluation. **Startup defaults to `TRADING_MODE=observe`; `TRADING_MODE=paper` enables the isolated virtual account. Strategy execution defaults off and requires approval/automatic opt-in. Both real broker clients still block order placement, modification, and cancellation.** Credentials, Jev, and the legacy mock override cannot enable real orders. `live` configuration fails at startup. Historical replay retains its separate simulated executor.

The paper backend supports persistent cash/share reservations, market/limit orders, cancellation/modification, stops, daily loss halts, journal records, and integer-paise P&L. The replay simulator remains separate from the paper wallet. Research results do not establish future profitability.

## Offline checks

Use Node.js 20 or newer and the pinned dependencies.

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm smoke
```

The suite covers observe isolation, both broker clients, paper accounting, restart recovery, failure rollback, and real localhost APIs. Native build approvals for `better-sqlite3` and `esbuild` are explicit. See [baseline results](docs/SAFETY.md#baseline-results) for the original SQLite repair.

## Local startup

No `.env` file is needed for `pnpm paper:demo`. For broker data, create `.env` using the settings in [Paper trading](docs/PAPER_TRADING.md). `pnpm start` defaults to observe and serves the dashboard at `http://127.0.0.1:8080`. Without credentials ordinary startup shows an empty session. With configured credentials the engine reads market data and records decisions. Jev, RSS, and Telegram can also use the network when configured.

For manual paper trading with broker quotes, set `TRADING_MODE=paper`. For a credential-free offline demonstration, run `pnpm paper:demo`. The demo labels synthetic quotes and stores a separate account in `data/paper-demo.db`. See [paper-trading commands](docs/PAPER_TRADING.md) and [enable approval or automatic strategy trading](docs/AUTOMATION.md). Use the browser order ticket, strategy approval/automation controls and journal; see [browser workflow](docs/DASHBOARD.md). Use [Backtesting](docs/BACKTESTING.md) to compare frozen datasets with separate holdout results; synthetic examples are not historical performance. The deterministic strategy requires no model key; the Jev adapter is tested offline but not verified against the real provider.

The dashboard has no authentication. Keep `HOST=127.0.0.1` and do not expose its controls publicly. Observe mode does not adopt, manage, or flatten existing broker positions.

## Documentation

- [Architecture and paper accounting](docs/ARCHITECTURE.md)
- [Existing features and reuse decisions](docs/EXISTING_FEATURES.md)
- [Roadmap and file-by-file implementation plan](docs/ROADMAP.md)
- [Safety audit and baseline results](docs/SAFETY.md)
- [Operate and verify paper trading](docs/PAPER_TRADING.md)
- [Approve or automate strategy signals](docs/AUTOMATION.md)
- [Operate the browser workspace](docs/DASHBOARD.md)
- [Evaluate strategies and inspect holdout results](docs/BACKTESTING.md)

## Commands

| Command | Behavior |
| --- | --- |
| `pnpm start` / `pnpm dev` | Observe scanner, optional paper account, local dashboard |
| `pnpm paper:demo` | Offline synthetic quotes and persistent paper account |
| `pnpm typecheck` | Strict TypeScript check |
| `pnpm test:safety` | Offline mode validation and broker mutation isolation |
| `pnpm test:paper` | Paper accounting, recovery, API, and demo checks |
| `pnpm test:backtest` | Evaluation integrity, metrics, holdout, persistence and worker isolation |
| `pnpm backtest:fixture` | Write a complete labeled synthetic dataset JSON example |
| `pnpm test:automation` | Strategy rules, AI validation, approvals, scheduling and failure isolation |
| `pnpm test` | Complete offline test suite including localhost HTTP |
| `pnpm smoke` | Fixture features, mock ranking, sizing, and governor on a scratch DB |
| `pnpm replay -- --date YYYY-MM-DD --speed 60` | Historical simulation; may fetch broker candles or call Jev; resets replay records for that date |
| `pnpm report` / `pnpm gates` | Reports over the configured database |
| `pnpm probe` | Broker payload inspection with a session |
| `pnpm calibrate` | Historical feature and model study; may access external services |
| `pnpm zerodha:login` | Login URL or request-token exchange |

`PAPER_*` settings are validated and documented in the operation guides. Paper fees use dated, configurable flat research estimates, separate from spread/slippage; they are not certified broker charges. The inherited replay cost module remains unchanged. Zerodha is the intended primary broker; the inherited provider default remains Kotak.

## Attribution

Derived from WarrenDuffer by arimanyus. The original MIT license and copyright remain unchanged in [LICENSE](LICENSE). Project repository: [Dip-Daemon](https://github.com/Abhi150904/Dip-Daemon).
