/** Explicit synthetic quotes on a virtual weekday session; no broker/model network access. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Quote } from "../src/types.js";

const demoPath = process.env.PAPER_DEMO_DB_PATH ?? "data/paper-demo.db";
Object.assign(process.env, {
  TRADING_MODE: "paper", MODEL: "mock", HOST: "127.0.0.1",
  DB_PATH: demoPath, KILL_PATH: `${demoPath}.kill`,
  RSS_FEEDS: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "",
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

const time = useVirtualClock(Date.parse("2026-10-26T04:15:00Z"));
const engine = new Engine(new SimBroker(new Map()));
engine.dataSource = "synthetic-fixtures";
const paper = new PaperExecutor(db, cfg.paper, () => engine.quotes, () => existsSync(cfg.killPath));
const latest = db.prepare<[], { ts: number | null }>("SELECT MAX(ts) AS ts FROM (SELECT updated_at AS ts FROM paper_orders UNION ALL SELECT mark_ts AS ts FROM paper_positions UNION ALL SELECT ts FROM paper_ledger)").get();
time.set(Math.max(clock.now(), latest?.ts ?? 0));
const prices = [100, 100.5, 101, 100.25, 99.5, 99, 100, 101.5, 102, 101];
let step = Math.floor((clock.now() - Date.parse("2026-10-26T04:15:00Z")) / 2000);
function update(): void {
  const price = prices[Math.floor(step / 5) % prices.length];
  for (const [symbol, offset] of [["INFY", 0], ["TCS", 20], ["RELIANCE", 40]] as const) {
    const mid = price + offset;
    const q: Quote = { symbol, token: symbol, segment: "nse_cm", ts: clock.now(),
      ltp: mid, bid: mid - 0.05, ask: mid + 0.05, tickSize: 0.05,
      ltq: 1, volume: 10000, tbq: 100, tsq: 100, bids: [{ price: mid - 0.05, qty: 100 }], asks: [{ price: mid + 0.05, qty: 100 }],
      open: mid, high: mid, low: mid, close: mid };
    engine.quotes.set(symbol, q);
  }
}
update();
const server = startServer(engine, undefined, cfg.port, paper);
const timer = setInterval(() => {
  step++;
  time.set(clock.now() + 2000);
  update();
  try { paper.tick(); } catch (error) { console.error("paper demo tick failed", error); }
}, 2000);
console.log(`SYNTHETIC FIXTURES ONLY. Virtual clock starts 09:45 IST. Paper records: ${resolve(cfg.dbPath)}`);
console.log("Use /api/paper/account, /api/paper/orders, /api/paper/positions and /api/paper/trades. No automatic entries.");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    server.closeAllConnections();
    server.close(() => { db.close(); process.exit(0); });
  });
}
