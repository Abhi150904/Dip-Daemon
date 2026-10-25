import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { BrokerOrder, BrokerPosition, PlaceResult } from "../src/broker.js";
import type { Bar } from "../src/types.js";

test("observe lifecycle stays isolated with broker positions and pending orders", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "dipdaemon-lifecycle-"));
  Object.assign(process.env, {
    DB_PATH: join(scratch, "audit.db"), KILL_PATH: join(scratch, "kill.switch"),
    TRADING_MODE: "observe", MODEL: "mock", RSS_FEEDS: "", TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "", OPTIONS_MODE: "off", WILD: "1", DAILY_LOSS_CAP: "1000",
    ENTRY_START: "09:30", ENTRY_END: "15:00", FLATTEN_AT: "15:10",
  });
  let closeDatabase = () => {};
  t.after(() => {
    closeDatabase();
    rmSync(scratch, { recursive: true, force: true });
  });
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("Unexpected external network access");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { db } = await import("../src/db.js");
  closeDatabase = () => db.close();
  const { cfg } = await import("../src/config.js");
  const { Engine } = await import("../src/engine.js");
  const { SimBroker } = await import("../src/replay/sim.js");
  const { MockModel } = await import("../src/model/mock.js");
  const { clock, useVirtualClock, istDateStr } = await import("../src/time.js");
  const vclock = useVirtualClock(Date.parse("2026-10-26T05:15:00Z"));
  t.after(() => { clock.now = () => Date.now(); });

  const bars = new Map<string, Bar[]>();
  for (const [symbol, base] of [["RELIANCE", 1400], ["TCS", 3500], ["Nifty 50", 24000]] as const) {
    bars.set(symbol, Array.from({ length: 81 }, (_, i) => {
      const close = i < 65 ? base + 30 : base + 26 + (i - 65) * 0.4;
      return { symbol, ts: clock.now() - (80 - i) * 60_000,
        open: close - 1, high: close + 1, low: close - 1, close, volume: 10000 + i * 50 };
    }));
  }

  class BrokerSpy extends SimBroker {
    mutations: string[] = [];
    accountReads: string[] = [];
    override async candles(token = ""): Promise<Bar[]> { return bars.get(token) ?? []; }
    override async positions(): Promise<BrokerPosition[]> {
      this.accountReads.push("positions");
      return [{ symbol: "RELIANCE", token: "RELIANCE", segment: "nse_cm", qty: 1, avgPrice: 1400, product: "MIS" }];
    }
    override async orders(): Promise<BrokerOrder[]> {
      this.accountReads.push("orders");
      return [{ orderId: "existing-real-order", symbol: "RELIANCE", status: "open", qty: 1,
        filledQty: 0, price: 1400, trigger: 0, side: "buy", product: "MIS", tag: "manual" }];
    }
    override async place(): Promise<PlaceResult> {
      this.mutations.push("place"); throw new Error("Unexpected broker place");
    }
    override async modify(): Promise<never> {
      this.mutations.push("modify"); throw new Error("Unexpected broker modify");
    }
    override async cancel(): Promise<never> {
      this.mutations.push("cancel"); throw new Error("Unexpected broker cancel");
    }
  }

  for (const model of ["mock", "jev"] as const) {
    for (const allowMock of [false, true]) {
      for (const restart of ["adopt", "flatten"] as const) {
        await t.test(`${model}, override=${allowMock}, restart=${restart}`, async () => {
          vclock.set(Date.parse("2026-10-26T05:15:00Z"));
          db.exec("DELETE FROM trades; DELETE FROM orders; DELETE FROM fills; DELETE FROM positions; DELETE FROM decisions; DELETE FROM events;");
          cfg.model = model;
          cfg.allowMockTrading = allowMock;
          cfg.onRestart = restart;
          const broker = new BrokerSpy(bars);
          const engine = new Engine(broker);
          assert.equal(engine.model.name, model);
          assert.equal(engine.canTrade, false);
          // Run real deterministic model evaluations without contacting the Jev service.
          const offlineModel = new MockModel();
          engine.model = { name: model, evaluate: (...args) => offlineModel.evaluate(...args) };
          await engine.start();
          assert.equal(engine.warmedUp, true);
          assert.ok(engine.universe.length >= 2);
          await engine.reconcile();
          await engine.tick(true);
          assert.notEqual(engine.taken, null, "fixture must reach the entry path");
          assert.notDeepEqual(db.prepare("SELECT id FROM events WHERE kind='observe' AND message LIKE 'observe: would %'").all(), []);
          assert.notDeepEqual(db.prepare("SELECT id FROM decisions LIMIT 1").all(), []);
          assert.equal(engine.snapshot().mode, "observe");
          assert.equal(engine.positions.size, 0);
          assert.deepEqual(broker.accountReads, []);

          engine.kill();
          await setImmediate();
          await engine.tick(true);
          assert.equal(engine.killed, true);
          engine.unkill();
          assert.equal(engine.killed, false);
          assert.equal(engine.sessionId, null);

          db.prepare("INSERT INTO trades (date, pnl) VALUES (?, ?)").run(istDateStr(), -cfg.dailyLossCap);
          await engine.tick(true);
          assert.equal(engine.halted, true);
          db.exec("DELETE FROM trades");
          vclock.set(Date.parse("2026-10-26T09:45:00Z")); // 15:15 IST, after scheduled flatten.
          await engine.tick(true);
          engine.shutdown();
          await setImmediate();

          // A second engine models restart with the same persistent account records.
          const recovered = new Engine(broker);
          recovered.model = { name: model, evaluate: (...args) => offlineModel.evaluate(...args) };
          await recovered.start();
          await recovered.reconcile();
          recovered.shutdown();
          assert.equal(recovered.positions.size, 0);
          assert.deepEqual(broker.mutations, []);
          assert.deepEqual(broker.accountReads, []);
          assert.deepEqual(db.prepare("SELECT id FROM orders").all(), []);
          assert.deepEqual(db.prepare("SELECT id FROM fills").all(), []);
          assert.deepEqual(db.prepare("SELECT id FROM positions").all(), []);
          assert.equal(networkCalls, 0);
        });
      }
    }
  }
});
