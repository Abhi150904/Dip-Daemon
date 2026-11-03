import './test-env.js';
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Broker, BrokerOrder, BrokerPosition, PlaceResult } from "../src/broker.js";
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
  const { LiveExecutor } = await import("../src/executor/live.js");
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
    override async cancel(): Promise<void> {
      this.mutations.push("cancel"); throw new Error("Unexpected broker cancel");
    }
  }

  await t.test("scanner receives quotes for stocks excluded by strategy price filters", async () => {
    const symbol = "WIPRO";
    bars.set(symbol, [{ symbol, ts: clock.now(), open: 250, high: 251, low: 249, close: 250, volume: 10000 }]);
    const engine = new Engine(new BrokerSpy(bars));
    await engine.start();
    assert.equal(engine.quotes.get(symbol)?.ltp, 250);
    assert.equal(engine.universe.some(member => member.symbol === symbol), false);
    await engine.feed.tick();
    assert.equal(engine.quotes.get(symbol)?.ltp, 250);
    engine.shutdown();
    bars.delete(symbol);
  });

  await t.test("lost broker acknowledgement blocks resubmission and recovers exactly one order", async () => {
    let submissions = 0;
    let brokerOrder: BrokerOrder | undefined;
    let offlinePosition = false;
    class LostResponseBroker extends BrokerSpy {
      override async place(args?: Parameters<Broker["place"]>[0]): Promise<PlaceResult> {
        assert.ok(args);
        submissions++;
        brokerOrder = { orderId: "recovery-fixture", symbol: "INFY", side: "buy", qty: 3, price: 100,
          filledQty: 0, trigger: 0, product: "MIS", status: "OPEN", tag: args.tag };
        throw new Error("Lost broker response");
      }
      override async orders(): Promise<BrokerOrder[]> { return brokerOrder ? [brokerOrder] : []; }
      override async positions(): Promise<BrokerPosition[]> {
        return offlinePosition ? [{ symbol: "INFY", token: "1", segment: "nse_cm", qty: 2, avgPrice: 99.5, product: "MIS" }] : [];
      }
      async orderTrades() { return [{ id: "t1", quantity: 1, price: 99 }, { id: "t2", quantity: 1, price: 100 }]; }
      override async cancel(): Promise<void> { if (brokerOrder) brokerOrder.status = "CANCEL PENDING"; }
    }
    const broker = new LostResponseBroker(bars);
    const intent = { kind: "entry", symbol: "INFY", tradingSymbol: "INFY", token: "1", segment: "nse_cm",
      side: "buy", qty: 3, price: 100, tag: "fixture", decisionId: null, leg: "equity", tier: "A", stop: 98, target: 103, stopBps: 150 } as const;
    const executor = new LiveExecutor(broker);
    await assert.rejects(executor.place(intent), /startup reconciliation is incomplete/);
    await executor.initialize();
    await assert.rejects(executor.place(intent), /Lost broker response/);
    await assert.rejects(executor.place(intent), /Unresolved broker submission/);
    const restarted = new LiveExecutor(broker);
    await assert.rejects(restarted.place(intent), /startup reconciliation is incomplete/);
    await restarted.initialize();
    await restarted.recoverSubmissions();
    assert.equal(submissions, 1);
    assert.deepEqual([...restarted.orders.values()].map(order => order.brokerId), ["recovery-fixture"]);
    const recoveredOrder = [...restarted.orders.values()][0];
    db.prepare("INSERT INTO fills (ts,order_id,qty,simulated) VALUES (?,?,?,0)").run(clock.now(), recoveredOrder.id, 1);
    const coldStart = new LiveExecutor(broker);
    await assert.rejects(coldStart.initialize(), /does not match saved order and fills/);
    await assert.rejects(coldStart.place(intent), /startup reconciliation is incomplete/);
    assert.equal(coldStart.orders.get(recoveredOrder.id)?.filledQty, 1);
    db.prepare("DELETE FROM fills WHERE order_id=?").run(recoveredOrder.id);
    await restarted.cancel(recoveredOrder);
    assert.ok(brokerOrder);
    brokerOrder.filledQty = 2;
    await restarted.tick(new Map());
    assert.equal(restarted.orders.has(recoveredOrder.id), true);
    brokerOrder.status = "CANCELLED";
    vclock.set(clock.now() + 2_001);
    await restarted.tick(new Map());
    assert.equal(recoveredOrder.status, "cancelled");
    assert.equal(restarted.orders.has(recoveredOrder.id), false);
    assert.deepEqual(db.prepare("SELECT qty, price FROM fills WHERE order_id=? ORDER BY id").all(recoveredOrder.id), [{ qty: 1, price: 99 }, { qty: 1, price: 100 }]);
    db.prepare("DELETE FROM broker_trade_receipts WHERE order_id=?").run(recoveredOrder.id);
    db.prepare("DELETE FROM fills WHERE order_id=?").run(recoveredOrder.id);
    db.prepare("UPDATE orders SET status='open' WHERE id=?").run(recoveredOrder.id);
    offlinePosition = true;
    for (let restart = 0; restart < 2; restart++) {
      const recovering = new LiveExecutor(broker);
      await assert.rejects(recovering.initialize(), /Open broker positions require reconciliation/);
      await assert.rejects(recovering.place(intent), /startup reconciliation is incomplete/);
      const recoveringEngine = new Engine(broker, { exec: new LiveExecutor(broker) });
      Object.defineProperty(recoveringEngine, "canTrade", { value: true });
      await assert.rejects(recoveringEngine.reconcile(), /protective stop requires reconciliation/);
    }
    assert.deepEqual(db.prepare("SELECT qty, entry, stop_order_id FROM positions WHERE entry_order_id=?").all(String(recoveredOrder.id)),
      [{ qty: 2, entry: 99.5, stop_order_id: null }]);
    assert.deepEqual(db.prepare("SELECT qty, price FROM fills WHERE order_id=? ORDER BY id").all(recoveredOrder.id), [{ qty: 1, price: 99 }, { qty: 1, price: 100 }]);
    assert.equal(submissions, 1);
    db.prepare("DELETE FROM broker_trade_receipts WHERE order_id=?").run(recoveredOrder.id);
    db.prepare("DELETE FROM fills WHERE order_id=?").run(recoveredOrder.id);
  });

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
