/** Offline pipeline smoke test on a scratch DB. Never touches the live DB. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";

const scratch = join(tmpdir(), `wd-smoke-${process.pid}.db`);
process.env.DB_PATH = scratch;
process.env.TRADING_MODE = "observe";
process.env.MODEL = "mock";
process.env.LIVE_QTY = "0";
process.env.RISK_PER_TRADE = "300";
process.env.RISK_PCT = "0.003";
process.env.MAX_NOTIONAL = "150000";
let database: Database.Database | undefined;

async function main(): Promise<void> {
  const { upsertBar, db } = await import("../src/db.js");
  database = db;
  const { useVirtualClock, clock } = await import("../src/time.js");
  useVirtualClock(Date.parse("2026-10-26T05:15:00Z"));
  const { buildFeatures, buildIndexFeatures } = await import("../src/data/features.js");
  const { MockModel } = await import("../src/model/mock.js");
  const { pickBest, runStage1, runStage2 } = await import("../src/strategy/continuation.js");
  const { computeGovernor } = await import("../src/strategy/governor.js");
  const { sizeQty, stopBps } = await import("../src/risk.js");
  type Quote = import("../src/types.js").Quote;

  const bar = (symbol: string, i: number, close: number) =>
    upsertBar({ symbol, ts: clock.now() - (80 - i) * 60_000, open: close - 1, high: close + 1, low: close - 1, close, volume: 10000 + i * 50 });
  const quote = (symbol: string, ltp: number): Quote => ({
    symbol,
    token: symbol,
    segment: "nse_cm",
    ts: clock.now(),
    ltp,
    ltq: 10,
    volume: 20000,
    bid: ltp - 0.05,
    ask: ltp + 0.05,
    tbq: 5000,
    tsq: 3000,
    bids: [{ price: ltp - 0.05, qty: 100 }],
    asks: [{ price: ltp + 0.05, qty: 80 }],
    open: ltp - 5,
    high: ltp + 3,
    low: ltp - 6,
    close: ltp,
    tickSize: 0.05,
  });

  for (let i = 0; i < 80; i++) {
    bar("RELIANCE", i, i < 65 ? 1430 : 1426 + (i - 65) * 0.4);
    bar("TCS", i, i < 65 ? 3514 : 3510 + (i - 65) * 0.4);
    bar("Nifty 50", i, 24000 + i);
  }
  const fR = buildFeatures("RELIANCE", quote("RELIANCE", 1432));
  const fT = buildFeatures("TCS", quote("TCS", 3516));
  assert.ok(fR);
  assert.ok(fT);
  const index = buildIndexFeatures(quote("Nifty 50", 24080), 0.1, 0.7);
  const model = new MockModel();
  const s1 = await runStage1(model, [fR, fT], index);
  if (!s1) throw new Error("stage1 failed");
  const cands = [];
  for (const r of [...s1.longs, ...s1.shorts]) {
    const c = await runStage2(model, r.symbol === "RELIANCE" ? fR : fT, index, r.side);
    if (c) cands.push(c);
  }
  const best = pickBest(cands);
  const sb = stopBps(fR.atr1m, fR.last);
  const qty = sb ? sizeQty(fR.last, sb, "A", 100000, 100000) : 0;
  const g = computeGovernor();
  assert.equal(best?.symbol, "RELIANCE");
  assert.ok(qty > 0 && Number.isInteger(qty), "fixture must produce a valid whole-share size");
  assert.ok(qty * fR.last <= 100000, "size must stay within fixture capital");
  assert.ok(cands.length > 0, "stage 2 must evaluate a candidate");
  assert.equal(g.reason, "green_uncapped");
  console.log({ regime: s1.regime, longs: s1.longs, best: best?.symbol, qty, governor: g.reason });
  console.log("smoke ok");
}

void main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    database?.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(scratch + suffix, { force: true });
  });
