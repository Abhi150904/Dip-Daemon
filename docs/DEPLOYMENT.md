# Deploy and recover DipDaemon

Phase 5 provides a single-account service with authentication, health checks, structured logs, reconnect backoff, graceful shutdown and verified SQLite backups. Real broker orders remain disabled. The default Compose deployment listens only on this computer.

## Start with Docker Desktop

Use Docker Desktop with the Linux engine running. From the project folder:

```powershell
pnpm auth:token
$env:TRADING_MODE = 'paper'
$env:MODEL = 'mock'
docker compose up -d --build
docker compose ps
```

The token generator creates `.secrets/dashboard-token` and refuses to overwrite an existing file. Open that private file locally and enter its value at `http://127.0.0.1:8080`. Do not paste it into chat or commit it. No `.env.example` is required. The generated token is also usable as an API Bearer token. Sign out invalidates the browser session; sessions expire after eight hours and are cleared on service restart.

Without broker credentials the workspace starts with no fresh market data. A healthy service does not imply that orders can fill. For synthetic quotes use `pnpm paper:demo` locally; this uses its separate account and blocks outgoing fetch. It forces loopback and a local browser origin while retaining configured authentication.

Compose uses named `account_data` and `backup_data` volumes. Rebuilding or ordinary `docker compose down` preserves them. **Do not use `down --volumes` on an account you want to keep.** To stop gracefully:

```powershell
docker compose stop
```

Shutdown stops new work, invalidates pending strategy work, drains active tasks, attempts a final backup and closes SQLite. It does not close recorded holdings. Protective exits cannot execute while the service is stopped or prices are missing/stale. Automation defaults off unless explicitly configured.

## Credentials and configuration

Compose maps explicit settings rather than injecting the entire host `.env`. Its defaults are observe mode, mock model, automation off, hourly backups and retention of 24 completed snapshots. `APP_PORT` changes the published loopback port. Paper limits/costs, strategy mode, backup interval/retention and shutdown timeout are listed in `compose.yaml`. Monetary paper settings are rupees at configuration boundaries; API balances remain integer paise.

For optional Zerodha market data, create private files `.secrets/zerodha-api-key` and `.secrets/zerodha-access-token`, containing the corresponding existing credentials, then run:

```powershell
docker compose -f compose.yaml -f compose.market.yaml up -d --build
```

This override selects paper mode and the deterministic strategy's mock model. It does not enable real orders. Real broker connectivity and credential renewal must be checked with your provider; this delivery tested reconnect behavior with offline fixtures.

For ordinary local `pnpm start`, settings can go in `.env`. Supported secrets accept either `NAME` or `NAME_FILE`, never both: `AUTH_TOKEN`, `KOTAK_ACCESS_TOKEN`, `KOTAK_MPIN`, `KOTAK_TOTP_SECRET`, `ZERODHA_API_KEY`, `ZERODHA_API_SECRET`, `ZERODHA_ACCESS_TOKEN`, `ZERODHA_REQUEST_TOKEN`, `AI_GATEWAY_API_KEY`, `TYPESAFE_AI_API_KEY`, `TELEGRAM_BOT_TOKEN`. Secret-file paths must be readable by the service account. Authentication tokens must contain 32–256 letters, digits, underscores or hyphens. Compose mounts the dashboard token as a file secret. Files under `.secrets` are excluded from Git and the image build context; restrict their host permissions and backups separately.

Non-loopback `HOST` requires `AUTH_TOKEN` (or its file) and an exact `APP_ORIGIN`. A non-loopback origin requires HTTPS. For a reverse proxy, configure its exact origin and set `TRUST_PROXY_IPS` to the proxy's actual connection IP; forwarded HTTPS headers are trusted only from those addresses. Keep the upstream port private. The included Compose file does not publish a public server or configure certificates. Public HTTPS operation has not been exercised. Browser Host, Origin and cross-site checks apply alongside authentication. This is a single shared workspace, without user roles or per-user audit identities.

The legacy interactive replay child ports are intended for local unauthenticated use; they are not published by Compose and do not provide a separate authenticated deployment workflow. Use the Backtesting page for deployed evaluation.

## Health and logs

- `/healthz` is public and minimal: database open/liveness only. Docker uses it.
- `/readyz` requires access and returns 503 during startup, shutdown or a stalled main loop.
- `/api/health` and Settings show readiness, last tick, backup status, feed retries and market freshness. They require access when authentication is enabled.

Read logs with `docker compose logs --tail 100 dipdaemon`. Service events are JSON; configured secret values and sensitive fields are redacted. Docker rotates logs at 10 MB with three files. Do not treat redaction as permission to log arbitrary private payloads. Feed retries use bounded exponential backoff and retain old quote timestamps, so a failed request cannot make old prices fresh. The strategy loop runs independently of the fast quote/risk loop.

The restart policy restarts a container that exits; an unhealthy health check alone does not trigger a Docker restart. See Docker's [restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/) and [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/). Monitor health and backup failures through your chosen external monitoring system; this delivery does not provision one or enable new external notifications.

## Back up, verify and restore

The service creates an online backup at startup, periodically and during graceful shutdown. Each completed backup has a `.db` and matching `.manifest.json` commit marker. Verification checks SHA-256, SQLite integrity/foreign keys and paper cash/reservation invariants before retention removes older generated pairs. Interrupted partial files are not completed backups. A verified backup proves structural consistency, not strategy profitability or broker reconciliation.

For a local database:

```powershell
pnpm backup create
pnpm backup verify 'data/backups/<snapshot>.db'
pnpm backup restore 'data/backups/<snapshot>.db' 'data/recovered.db'
```

`DB_PATH` selects the source; `BACKUP_DIR` defaults to `data/backups`. Restore requires a **new destination** and refuses an existing database or SQLite sidecar. Preserve the manifest with its backup. Stop the application before changing `DB_PATH` to the recovered file, then restart and inspect account cash, positions, reservations, journal and saved evaluations before enabling automation.

Inside Compose, run `docker compose exec dipdaemon pnpm backup create /backups`. List snapshots with `docker compose exec dipdaemon ls /backups`. Verify or restore using the same commands with `/backups/<snapshot>.db` and a new target such as `/app/data/recovered.db`. To use the recovered file, set the service's `DB_PATH` in a private Compose override, recreate the service, and inspect the account before enabling automation. Preserve the old database for investigation.

Copy complete backup/manifest pairs to a separate protected device or service and test recovery there. The supplied backup volume is on the same Docker host, so it does not protect against host loss. Off-host copying, encryption/key custody and retention policy remain operator responsibilities.

## Verification record

On 29 October 2026 the isolated Docker project built and became healthy. Authentication was checked through HTTP and the browser. A synthetic paper position and saved evaluation survived container restart; a verified snapshot restored into a new database with those records intact. Automated checks cover authentication/session revocation, trusted proxy boundaries, retry freshness, serial loops, shutdown/fatal exit and restore/tamper handling. Production credentials, real provider recovery and public HTTPS were not exercised.
