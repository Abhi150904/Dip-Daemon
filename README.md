# DipDaemon

DipDaemon is a local trading platform for NSE equities. It brings market scanning, strategy evaluation, order execution, and trade review into one browser dashboard. Run a credential-free demo, paper trade with Zerodha quotes, or connect a Zerodha account for live intraday execution.

## What you can do

| Workflow | What DipDaemon provides |
| --- | --- |
| Scan the market | Review quotes and strategy decisions across the configured universe. |
| Evaluate signals | Compare rule-based VWAP momentum with a model-assisted workflow. |
| Paper trade | Approve signals individually or automate simulated orders. Track virtual cash, orders, positions, and P&L. |
| Backtest and review | Compare strategies on saved datasets with holdout results. Review closed trades, estimated fees, and exit reasons in the journal. |
| Run the live bot | Route intraday orders through Zerodha Kite. Review broker state at startup and explicitly arm new entries from the dashboard. |

## How it works

The TypeScript engine ingests quotes, builds strategy features, and routes approved orders to the paper or broker executor. SQLite records orders, fills, and decisions so trades can be reviewed from signal through exit. The live executor reconciles broker orders and positions at startup and uses persisted submission intents to recover orders by tag when a broker acknowledgement is lost.

## Run the paper demo

Install Node.js 20 or newer and pnpm. From the project folder, run these commands.

```powershell
pnpm install
pnpm paper:demo
```

Open [DipDaemon on localhost](http://127.0.0.1:8080). The demo uses synthetic quotes and stores its paper account in `data/paper-demo.db`. It runs without credentials or an `.env` file.

## Use Zerodha quotes for paper trading

Create a local `.env` file with these settings. Fill in the three Zerodha values with your own credentials.

```dotenv
TRADING_MODE=paper
BROKER=zerodha
ZERODHA_API_KEY=
ZERODHA_API_SECRET=
ZERODHA_ACCESS_TOKEN=
```

Use `pnpm zerodha:login` for the login and token exchange workflow. Then run `pnpm start` and open the dashboard on port 8080. Keep `.env` and local trading data out of Git. See the [paper trading guide](docs/PAPER_TRADING.md) and the [strategy automation guide](docs/AUTOMATION.md).

## Run the Kite sandbox bot

Run `pnpm zerodha:sandbox login` to get the sandbox login URL. Set `KITE_SANDBOX_REQUEST_TOKEN` from the redirect in your local PowerShell session. Exchange it and start the bot from that same session.

```powershell
$env:KITE_SANDBOX_ACCESS_TOKEN = node scripts/zerodha-sandbox.mjs exchange
pnpm zerodha:sandbox positions
pnpm zerodha:sandbox-bot
```

Open the [Kite sandbox dashboard](http://127.0.0.1:8082/sandbox.html). The bot starts disarmed and uses a separate database. On startup it checks broker orders and positions against its saved records. If earlier manual sandbox tests left an open order or position, resolve that exposure before arming the bot.

## Connect a live Zerodha account

Start with the Zerodha credentials from the paper setup. Set `TRADING_MODE=live`, `HOST=127.0.0.1`, `OPTIONS_MODE=off`, and `MODEL=jev` in `.env`. Configure your model credentials and run `pnpm auth:token` to create a dashboard token file. Set `AUTH_TOKEN_FILE=.secrets/dashboard-token` in `.env`.

```powershell
pnpm zerodha:preflight
pnpm start
```

The preflight checks broker authentication and reports working orders and open positions. After it succeeds, start the app and open **Live bot controls** from the dashboard sidebar. The bot starts disarmed. Select **Arm live bot** when you intend to allow real-money orders. Arming requires startup reconciliation, fresh quotes, and clear risk checks. Use **Pause new entries** to stop new trades while the bot continues to manage existing positions.

## Verification status

- **Paper trading** was exercised with Zerodha quotes, including manual orders, VWAP approvals, and closed trades in the journal.
- **Kite sandbox** fills, cancellations, and recovery by order tag were verified individually. The full automated entry, stop, exit, and restart sequence still needs verification against Kite.
- **Live Zerodha** authentication and the dashboard controls were verified. A real order and fill have yet to be verified.

Run the local checks with:

```powershell
pnpm typecheck
pnpm test
pnpm smoke
```

See the [dashboard guide](docs/DASHBOARD.md), [backtesting guide](docs/BACKTESTING.md), [architecture](docs/ARCHITECTURE.md), and [deployment and recovery guide](docs/DEPLOYMENT.md).


