import { brokerConfigured, cfg } from "./config.js";
import { createBroker } from "./broker.js";
import { Engine } from "./engine.js";
import { startServer } from "./server.js";
import { alert } from "./alerts.js";
import { existsSync } from "node:fs";
import { db } from "./db.js";
import { PaperExecutor } from "./executor/paper.js";
import { PaperAutomation } from "./automation/paper.js";
import { buildFeatures, buildIndexFeatures, loadBars } from "./data/features.js";
import { INDEX_TOKEN } from "./symbols.js";
import { Backups } from "./ops/backup.js";
import { Health, ServiceLoop, installLifecycle, waitForIdle } from "./ops/runtime.js";
import { log } from "./ops/log.js";
import { stopEvaluations } from "./backtest/store.js";

const client = createBroker(() => {
  void alert("session", cfg.broker === "zerodha" ? "kite session expired; run pnpm zerodha:login, set ZERODHA_ACCESS_TOKEN, restart. Entries halted" : "session expired and re-login failed; entries halted");
});

const engine = new Engine(client);
const paper = cfg.tradingMode === "paper" ? new PaperExecutor(db, cfg.paper, () => engine.quotes, () => existsSync(cfg.killPath)) : undefined;
const automation = new PaperAutomation(db, paper, () => {
  const symbols = new Set([...engine.universe.map(u => u.symbol), ...(paper?.wallet.positions().map(p => p.symbol) ?? [])]);
  const quotes = [...engine.quotes.values()].filter(q => symbols.has(q.symbol));
  const features = quotes.flatMap(q => { const f = buildFeatures(q.symbol, q); return f ? [f] : []; });
  return { source: engine.dataSource, quotes, features, bars: new Map(quotes.map(q => [q.symbol, loadBars(q.symbol)])),
    index: buildIndexFeatures(engine.quotes.get(INDEX_TOKEN), 0, features.length ? features.filter(f => f.vwapDist.value > 0).length / features.length : 0), indexTs: engine.quotes.get(INDEX_TOKEN)?.ts ?? null };
}, engine.model, cfg.automation);
engine.extraActiveTokens = () => paper ? [...new Set([...paper.positions().map(p => p.symbol), ...paper.orders().filter(o => o.status === "open").map(o => o.symbol)])]
  .flatMap(symbol => {
    const instrument = client.getInstrument(symbol);
    return instrument ? [{ token: instrument.token, segment: instrument.segment, symbol }] : [];
  }) : [];

const health = new Health();
health.phase = "starting";
const backups = new Backups(db, cfg.operations.backupDir, cfg.operations.backupKeep);
const backupState: { lastSuccess: number | null; lastFailure: number | null } = { lastSuccess: null, lastFailure: null };
health.backup = backupState;
const runBackup = async () => {
  try { await backups.run(); log("info", "backup_verified"); }
  catch (error) { log("error", "backup_failed", { error }); }
  finally { backupState.lastSuccess = backups.lastSuccess; backupState.lastFailure = backups.lastFailure; }
};
const configured = brokerConfigured();
let initialized = false;
const loop = new ServiceLoop(async () => {
  if (!initialized) {
    if (configured) await engine.start();
    else log("warn", "market_data_unconfigured", { mode: cfg.tradingMode });
    initialized = true;
    if (health.phase !== "stopping") health.phase = "running";
  }
  await engine.tick();
  paper?.tick();
}, health);
// Model latency must never delay fresh quotes, stops or paper risk checks.
const strategyLoop = new ServiceLoop(async () => { if (initialized) await automation.tick(); }, new Health(), 2000, "strategy");
const server = startServer(engine, undefined, cfg.port, paper, automation, health);
const backupTimer = setInterval(() => { if (health.phase !== "stopping") void runBackup(); }, cfg.operations.backupIntervalMinutes * 60000);
installLifecycle({ health, timeoutMs: cfg.operations.shutdownMs,
  prepare() { clearInterval(backupTimer); automation.stop(); engine.shutdown(); },
  async close() {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await stopEvaluations();
    await loop.stop();
    await strategyLoop.stop();
    await waitForIdle(() => engine.idle && automation.idle);
    await closed;
    await backups.drain();
    await runBackup();
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  },
});
void runBackup();
loop.start();
strategyLoop.start();
