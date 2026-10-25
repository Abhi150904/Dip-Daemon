# DipDaemon

**Scan. Simulate. Trade.**

DipDaemon is an NSE trading research platform derived from [WarrenDuffer](https://github.com/arimanyus/warrenduffer). Its inherited TypeScript engine combines market features, Jev ranking, deterministic risk gates, SQLite records, historical replay, and a local dashboard.

Phase 0 is complete; Phase 1 is planned. **Normal startup supports `TRADING_MODE=observe` only. Both broker clients block real order placement, modification, and cancellation.** Credentials, `MODEL=jev`, and `ALLOW_MOCK_TRADING=1` cannot enable orders. Paper and live configuration fail at startup. Historical replay retains its explicitly injected simulated executor.

A persistent paper account is not implemented. The replay simulator is not a virtual wallet. Research results do not establish future profitability.

## Offline checks

Use Node.js 20 or newer and the pinned dependencies.

```powershell
pnpm install
pnpm typecheck
pnpm test:safety
pnpm smoke
```

Type checking, the safety suite (11 tests including eight lifecycle combinations), and the deterministic smoke test pass. SQLite's missing native binary was repaired, and build approvals for `better-sqlite3` and `esbuild` are explicit in `pnpm-workspace.yaml`. See [baseline results](docs/SAFETY.md#baseline-results) for the original failures and repair.

## Local startup

Copy `.env.example` to `.env` and leave `TRADING_MODE=observe`. `pnpm start` serves the dashboard at `http://127.0.0.1:8080`. Without credentials it shows an empty session; fixture-based CLI startup is pending, while automated tests exercise the engine with fixtures. With configured credentials the engine reads market data and records decisions. Jev, RSS, and Telegram can also use the network when configured.

The dashboard has no authentication. Keep `HOST=127.0.0.1` and do not expose its controls publicly. Observe mode does not adopt, manage, or flatten existing broker positions.

## Documentation

- [Architecture and proposed paper design](docs/ARCHITECTURE.md)
- [Existing features and reuse decisions](docs/EXISTING_FEATURES.md)
- [Roadmap and file-by-file implementation plan](docs/ROADMAP.md)
- [Safety audit and baseline results](docs/SAFETY.md)

## Commands

| Command | Behavior |
| --- | --- |
| `pnpm start` / `pnpm dev` | Observe engine and local dashboard |
| `pnpm typecheck` | Strict TypeScript check |
| `pnpm test:safety` | Offline mode validation and broker mutation isolation |
| `pnpm smoke` | Fixture features, mock ranking, sizing, and governor on a scratch DB |
| `pnpm replay -- --date YYYY-MM-DD --speed 60` | Historical simulation; may fetch broker candles or call Jev; resets replay records for that date |
| `pnpm report` / `pnpm gates` | Reports over the configured database |
| `pnpm probe` | Broker payload inspection with a session |
| `pnpm calibrate` | Historical feature and model study; may access external services |
| `pnpm zerodha:login` | Login URL or request-token exchange |

Proposed `PAPER_*` variables are not implemented. Existing costs are estimates without date versions or brokerage. Zerodha is the intended primary broker; the inherited default remains Kotak during the audit.

## Attribution

Derived from WarrenDuffer by arimanyus. The original MIT license and copyright remain unchanged in [LICENSE](LICENSE). Project repository: [Dip-Daemon](https://github.com/Abhi150904/Dip-Daemon).
