import { installCrashHandler } from "./alerts.js";
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

installCrashHandler();

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

async function main(): Promise<void> {
  if (!brokerConfigured()) {
    console.error(`Set ${cfg.broker === "zerodha" ? "ZERODHA_*" : "KOTAK_*"} in .env (see docs/PAPER_TRADING.md), or run pnpm paper:demo. Starting dashboard-only with empty session.`);
  } else {
    try {
      await engine.start();
    } catch (e) {
      console.error("startup failed (dashboard still up):", e);
      void alert("session", `startup failed ${e}`);
    }
  }
  startServer(engine, undefined, cfg.port, paper, automation);
  setInterval(() => {
    void engine.tick().then(() => { paper?.tick(); void automation.tick().catch(e => console.error("automation", e)); }).catch((e) => console.error("tick", e));
  }, 2000);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      engine.shutdown();
      process.exit(0);
    });
  }
}

void main();
