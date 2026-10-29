/** Explicit synthetic quotes on a virtual weekday session; no broker/model network access. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Quote } from "../src/types.js";

const demoPath = process.env.PAPER_DEMO_DB_PATH ?? "data/paper-demo.db";
Object.assign(process.env, {
  TRADING_MODE: "paper", MODEL: "mock", HOST: "127.0.0.1", APP_ORIGIN: "",
  DB_PATH: demoPath, KILL_PATH: `${demoPath}.kill`,
  RSS_FEEDS: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_BOT_TOKEN_FILE: "", TELEGRAM_CHAT_ID: "",
  PAPER_AUTOMATION_MODE: "off", PAPER_STRATEGY: "vwap_momentum",
  BACKUP_DIR: process.env.BACKUP_DIR ?? `${demoPath}.backups`,
});
// This script must remain offline even if private broker credentials exist in .env.
globalThis.fetch = async () => { throw new Error("Synthetic demo cannot access external services"); };

const { Engine } = await import("../src/engine.js");
const { SimBroker } = await import("../src/replay/sim.js");
const { db } = await import("../src/db.js");
const { cfg } = await import("../src/config.js");
const { PaperExecutor } = await import("../src/executor/paper.js");
const { clock, useVirtualClock } = await import("../src/time.js");
const { startServer } = await import("../src/server.js");
const { PaperAutomation } = await import("../src/automation/paper.js");
const { loadBars, buildFeatures } = await import("../src/data/features.js");
const { applyQuoteToBar } = await import("../src/data/bars.js");

const time = useVirtualClock(Date.parse("2026-10-26T04:15:00Z"));
const engine = new Engine(new SimBroker(new Map()));
engine.dataSource = "synthetic-fixtures";
const paper = new PaperExecutor(db, cfg.paper, () => engine.quotes, () => existsSync(cfg.killPath));
const latest = db.prepare<[], { ts: number | null }>("SELECT MAX(ts) AS ts FROM (SELECT updated_at AS ts FROM paper_orders UNION ALL SELECT mark_ts AS ts FROM paper_positions UNION ALL SELECT ts FROM paper_ledger)").get();
time.set(Math.max(clock.now(), latest?.ts ?? 0));
if (db.prepare("SELECT name FROM sqlite_master WHERE name='paper_strategy_runs'").get()) {
  const scan = db.prepare<[], { ts: number | null }>("SELECT MAX(COALESCE(completed_at,started_at)) AS ts FROM paper_strategy_runs").get();
  time.set(Math.max(clock.now(), scan?.ts ?? 0));
}
const prices = [100, 100.5, 101, 100.25, 99.5, 99, 100, 101.5, 102, 101];
let step = Math.floor((clock.now() - Date.parse("2026-10-26T04:15:00Z")) / 2000);
for (const [symbol, offset] of [["INFY", 0], ["TCS", 20], ["RELIANCE", 40]] as const) {
  for (let i = 0; i < 30; i++) {
    const close = 99.2 + offset + i * 0.025;
    const ts = Math.floor(clock.now() / 60000) * 60000 - (30 - i) * 60000;
    db.prepare("INSERT OR IGNORE INTO bars_1m(symbol,ts,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?)").run(symbol, ts, close - 0.02, close + 0.06, close - 0.06, close, i === 29 ? 2000 : 1000);
  }
}
function update(): void {
  const price = prices[Math.floor(step / 5) % prices.length];
  for (const [symbol, offset] of [["INFY", 0], ["TCS", 20], ["RELIANCE", 40]] as const) {
    const mid = price + offset;
    const q: Quote = { symbol, token: symbol, segment: "nse_cm", ts: clock.now(),
      ltp: mid, bid: mid - 0.05, ask: mid + 0.05, tickSize: 0.05,
      ltq: 1, volume: 10000 + step * 100, tbq: 100, tsq: 100, bids: [{ price: mid - 0.05, qty: 100 }], asks: [{ price: mid + 0.05, qty: 100 }],
      open: mid, high: mid, low: mid, close: mid };
    engine.quotes.set(symbol, q);
    applyQuoteToBar(q);
  }
}
update();
const automation = new PaperAutomation(db, paper, () => {
  const quotes = [...engine.quotes.values()];
  return { source: "synthetic-fixtures", quotes, bars: new Map(quotes.map(q => [q.symbol, loadBars(q.symbol)])),
    features: quotes.flatMap(q => { const f = buildFeatures(q.symbol, q); return f ? [f] : []; }), index: null, indexTs: null };
}, engine.model, { ...cfg.automation, strategy: "vwap_momentum" });
const { Health, ServiceLoop, installLifecycle, waitForIdle } = await import("../src/ops/runtime.js");
const { Backups } = await import("../src/ops/backup.js");
const { stopEvaluations } = await import("../src/backtest/store.js");
const { log } = await import("../src/ops/log.js");
const health = new Health();
const backups = new Backups(db, cfg.operations.backupDir, cfg.operations.backupKeep);
const backupState: { lastSuccess: number | null; lastFailure: number | null } = { lastSuccess: null, lastFailure: null };
health.backup = backupState;
const runBackup = async () => {
  try { await backups.run(); log("info", "backup_verified"); }
  catch (error) { log("error", "backup_failed", { error }); }
  finally { backupState.lastSuccess = backups.lastSuccess; backupState.lastFailure = backups.lastFailure; }
};
const server = startServer(engine, undefined, cfg.port, paper, automation, health);
const loop = new ServiceLoop(async () => {
  step++;
  time.set(clock.now() + 2000);
  update();
  paper.tick();
}, health);
const strategyLoop = new ServiceLoop(async () => { await automation.tick(); }, new Health(), 2000, "strategy");
console.log(`SYNTHETIC FIXTURES ONLY. Virtual clock starts 09:45 IST. Paper records: ${resolve(cfg.dbPath)}`);
console.log("Use /api/paper/* and /api/automation/*. Strategy execution defaults off; enable approval or automatic mode explicitly.");
const backupTimer = setInterval(() => { void runBackup(); }, cfg.operations.backupIntervalMinutes * 60000);
installLifecycle({ health, timeoutMs: cfg.operations.shutdownMs,
  prepare() { clearInterval(backupTimer); automation.stop(); engine.shutdown(); },
  async close() {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await stopEvaluations(); await loop.stop(); await strategyLoop.stop();
    await waitForIdle(() => automation.idle); await closed; await backups.drain(); await runBackup();
    db.pragma("wal_checkpoint(TRUNCATE)"); db.close();
  },
});
void runBackup(); loop.start(); strategyLoop.start();
