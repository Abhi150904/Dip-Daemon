import { installCrashHandler } from "./alerts.js";
import { brokerConfigured, cfg } from "./config.js";
import { createBroker } from "./broker.js";
import { Engine } from "./engine.js";
import { startServer } from "./server.js";
import { alert } from "./alerts.js";
import { existsSync } from "node:fs";
import { db } from "./db.js";
import { PaperExecutor } from "./executor/paper.js";

installCrashHandler();

const client = createBroker(() => {
  void alert("session", cfg.broker === "zerodha" ? "kite session expired; run pnpm zerodha:login, set ZERODHA_ACCESS_TOKEN, restart. Entries halted" : "session expired and re-login failed; entries halted");
});

const engine = new Engine(client);
const paper = cfg.tradingMode === "paper" ? new PaperExecutor(db, cfg.paper, () => engine.quotes, () => existsSync(cfg.killPath)) : undefined;
engine.extraActiveTokens = () => paper ? [...new Set([...paper.positions().map(p => p.symbol), ...paper.orders().filter(o => o.status === "open").map(o => o.symbol)])]
  .flatMap(symbol => {
    const instrument = client.getInstrument(symbol);
    return instrument ? [{ token: instrument.token, segment: instrument.segment, symbol }] : [];
  }) : [];

async function main(): Promise<void> {
  if (!brokerConfigured()) {
    console.error(`Set ${cfg.broker === "zerodha" ? "ZERODHA_*" : "KOTAK_*"} in .env (see .env.example). Starting dashboard-only with empty session.`);
  } else {
    try {
      await engine.start();
    } catch (e) {
      console.error("startup failed (dashboard still up):", e);
      void alert("session", `startup failed ${e}`);
    }
  }
  startServer(engine, undefined, cfg.port, paper);
  setInterval(() => {
    void engine.tick().then(() => paper?.tick()).catch((e) => console.error("tick", e));
  }, 2000);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      engine.shutdown();
      process.exit(0);
    });
  }
}

void main();
