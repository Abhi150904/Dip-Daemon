import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { PaperExecutor } from "../src/executor/paper.js";
import { paperSettings } from "../src/portfolio/types.js";
import { clock, useVirtualClock } from "../src/time.js";
import type { Quote } from "../src/types.js";

const start = Date.parse("2026-10-26T04:15:00Z"); // 09:45 IST
function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}, path = ":memory:") {
  const time = useVirtualClock(start);
  const db = new Database(path);
  const quotes = new Map<string, Quote>();
  const settings = paperSettings({ PAPER_SLIPPAGE_BPS: "0", PAPER_FEE_BPS: "0", ...env });
  let killed = false;
  const update = (symbol: string, price: number, ts = clock.now()) => {
    quotes.set(symbol, { symbol, token: symbol, segment: "nse_cm", ts, ltp: price,
      bid: price, ask: price, tickSize: 0.05, volume: 1000, ltq: 1, tbq: 100, tsq: 100,
      bids: [{ price, qty: 100 }], asks: [{ price, qty: 100 }], open: price, high: price, low: price, close: price });
  };
  update("INFY", 100); update("TCS", 100); update("RELIANCE", 100); update("HDFCBANK", 100);
  const paper = new PaperExecutor(db, settings, () => quotes, () => killed);
  t.after(() => { if (db.open) db.close(); clock.now = () => Date.now(); });
  return { paper, db, quotes, settings, update, time, kill: () => { killed = true; } };
}
const buy = (key = "buy", qty = 5) => ({ idempotencyKey: key, symbol: "INFY", side: "buy", type: "market", qty });
const sell = (key = "sell", qty = 5) => ({ idempotencyKey: key, symbol: "INFY", side: "sell", type: "market", qty });

test("paper settings reject invalid numbers, quantities and modes of accounting", () => {
  assert.equal(paperSettings({}).initialCapital, 1_000_000);
  for (const env of [{ PAPER_INITIAL_CAPITAL: "NaN" }, { PAPER_MAX_POSITIONS: "1.2" }, { PAPER_FEE_BPS: "-1" }, { PAPER_QUOTE_MAX_AGE_MS: "" }]) assert.throws(() => paperSettings(env));
});

test("buy/reduce/close reconciles cash, integer fee allocation and net P&L", t => {
  const f = fixture(t, { PAPER_FEE_BPS: "5" });
  assert.equal(f.paper.submit(buy()).status, "filled");
  assert.equal(f.paper.account().cash, 949975);
  f.update("INFY", 110);
  assert.equal(f.paper.submit(sell("reduce", 2)).status, "filled");
  assert.equal(f.paper.positions()[0].qty, 3);
  assert.equal(f.paper.submit(sell("close", 3)).status, "filled");
  const account = f.paper.account();
  assert.equal(account.cash, 1004947);
  assert.equal(account.fees, 53);
  assert.equal(account.realizedPnl, 4947);
  assert.equal(account.initialCapital + account.realizedPnl, account.equity);
  assert.equal(account.reservedCash, 0);
  assert.equal(f.paper.positions().length, 0);
  assert.equal(f.paper.trades().length, 2);
});

test("invalid orders, missing prices, cash and order-value limits fail closed", t => {
  const f = fixture(t, { PAPER_INITIAL_CAPITAL: "100" });
  for (const qty of [0, -1, 0.5, Infinity]) assert.throws(() => f.paper.submit(buy(`bad-${qty}`, qty)));
  assert.match(f.paper.submit(buy("no-cash", 2)).reason, /Insufficient/);
  assert.match(f.paper.submit(buy("too-large", 11)).reason, /maximum/);
  f.quotes.clear();
  assert.equal(f.paper.submit(buy("no-quote")).status, "rejected");
  assert.equal(f.paper.account().cash, 10000);
});

test("resting limit reservation survives price changes, modifies, cancels, and fills within limit", t => {
  const f = fixture(t);
  const o = f.paper.submit({ ...buy(), type: "limit", limitPrice: 90 });
  assert.equal(o.status, "open");
  assert.equal(f.paper.account().reservedCash, 45000);
  assert.equal(f.paper.modify(o.id, { limitPrice: 95 }).reserved_paise, 47500);
  f.time.set(start + 1000); f.update("INFY", 94);
  f.paper.tick();
  assert.equal(f.paper.order(o.id).fill_paise, 9400);
  assert.equal(f.paper.account().reservedCash, 0);
  const pending = f.paper.submit({ ...buy("another"), symbol: "TCS", type: "limit", limitPrice: 90 });
  f.paper.cancel(pending.id); f.paper.cancel(pending.id);
  assert.equal(f.paper.account().reservedCash, 0);
  assert.throws(() => f.paper.modify(o.id, { limitPrice: 90 }), /open limit/);
});

test("pending share reservations prevent overselling and allow cancellation", t => {
  const f = fixture(t);
  assert.equal(f.paper.submit(sell()).status, "rejected");
  f.paper.submit(buy());
  const pending = f.paper.submit({ ...sell("pending", 4), type: "limit", limitPrice: 120 });
  assert.equal(pending.status, "open");
  assert.equal(f.paper.submit(sell("oversell", 2)).status, "rejected");
  f.paper.cancel(pending.id);
  assert.equal(f.paper.submit(sell("close")).status, "filled");
});

test("idempotent retries create one fill and conflicting keys reject", t => {
  const f = fixture(t);
  const o = f.paper.submit(buy());
  assert.equal(f.paper.submit(buy()).id, o.id);
  f.paper.tick(); f.paper.tick();
  assert.equal(f.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM paper_fills").get()?.n, 1);
  assert.equal(f.paper.ledger().length, 2);
  assert.throws(() => f.paper.submit(buy("buy", 3)), /different request/);
});

test("stale, future, crossed, and invalid quotes never fill; later fresh quotes may fill", t => {
  const f = fixture(t);
  const pending = f.paper.submit({ ...buy(), type: "limit", limitPrice: 90 });
  f.time.set(start + 20000); f.update("INFY", 80, start);
  f.paper.tick(); assert.equal(f.paper.order(pending.id).status, "open");
  f.update("INFY", 80, clock.now() + 1); f.paper.tick();
  assert.equal(f.paper.order(pending.id).status, "open");
  f.update("INFY", 80); f.paper.tick();
  assert.equal(f.paper.order(pending.id).status, "filled");
  f.time.set(start + 40000);
  assert.equal(f.paper.account().equity, null);
  const q = f.quotes.get("TCS"); assert.ok(q);
  f.quotes.set("TCS", { ...q, ts: clock.now(), bid: 105, ask: 100 });
  assert.equal(f.paper.submit({ ...buy("crossed"), symbol: "TCS" }).status, "rejected");
});

test("pending buys count toward the position cap and cannot increase an existing position", t => {
  const f = fixture(t, { PAPER_MAX_POSITIONS: "1" });
  const pending = f.paper.submit({ ...buy(), type: "limit", limitPrice: 90 });
  assert.equal(f.paper.submit({ ...buy("cap"), symbol: "TCS" }).status, "rejected");
  f.paper.cancel(pending.id); f.paper.submit(buy("filled"));
  assert.match(f.paper.submit(buy("increase")).reason, /Increasing/);
});

test("stop and daily-loss exits are durable and do not need broker methods", t => {
  const f = fixture(t, { PAPER_DAILY_LOSS_LIMIT: "50" });
  f.paper.submit({ ...buy(), stopLoss: 95 });
  f.time.set(start + 1000); f.update("INFY", 94); f.paper.tick();
  assert.equal(f.paper.positions().length, 0);
  assert.equal(f.paper.orders().at(-1)?.status, "filled");
  f.paper.submit(buy("again"));
  f.time.set(start + 2000); f.update("INFY", 80); f.paper.tick();
  assert.equal(f.paper.account().halted, true);
  assert.equal(f.paper.positions().length, 0);
  assert.equal(f.paper.submit(buy("halted")).status, "rejected");
  const restarted = new PaperExecutor(f.db, f.settings, () => f.quotes);
  assert.equal(restarted.account().halted, true);
  assert.equal(restarted.submit(buy("halted-after-restart")).status, "rejected");
});

test("fee assumptions must be effective before any fill", t => {
  const f = fixture(t, { PAPER_FEE_EFFECTIVE_FROM: "2026-10-27" });
  assert.equal(f.paper.submit(buy()).status, "rejected");
  assert.equal(f.paper.ledger().length, 1);
});

test("kill cancels pending buys and exits positions", t => {
  const f = fixture(t);
  f.paper.submit(buy());
  const pending = f.paper.submit({ ...buy("pending"), symbol: "TCS", type: "limit", limitPrice: 90 });
  f.kill(); f.paper.tick();
  assert.equal(f.paper.order(pending.id).status, "cancelled");
  assert.equal(f.paper.positions().length, 0);
  assert.equal(f.paper.submit(buy("killed")).status, "rejected");
  assert.equal(f.paper.submit({ ...sell("day"), symbol: "TCS" }).status, "rejected");
});

test("DAY orders expire, session flatten closes shares, and closed sessions reject entries", t => {
  const f = fixture(t);
  f.paper.submit(buy());
  const pending = f.paper.submit({ ...buy("pending"), symbol: "TCS", type: "limit", limitPrice: 90 });
  f.time.set(Date.parse("2026-10-26T09:41:00Z"));
  f.update("INFY", 101); f.paper.tick();
  assert.equal(f.paper.positions().length, 0);
  assert.equal(f.paper.order(pending.id).status, "cancelled");
  f.time.set(Date.parse("2026-10-27T04:15:00Z")); f.update("INFY", 100);
  const next = f.paper.submit({ ...buy("next"), type: "limit", limitPrice: 90 });
  f.time.set(Date.parse("2026-10-27T10:01:00Z")); f.paper.tick();
  assert.equal(f.paper.order(next.id).status, "expired");
  assert.equal(f.paper.account().reservedCash, 0);
  assert.equal(f.paper.submit(buy("closed")).status, "rejected");
});

test("fresh quotes received before submission are valid, including protective exits", t => {
  const f = fixture(t);
  f.update("INFY", 100, start - 1000);
  assert.equal(f.paper.submit({ ...buy(), stopLoss: 95 }).status, "filled");
  f.time.set(start + 2000); f.update("INFY", 94, start + 1000); f.paper.tick();
  assert.equal(f.paper.positions().length, 0);
});

test("paper accepts the shared PlaceIntent contract with a durable idempotency key", t => {
  const f = fixture(t);
  const o = f.paper.place({ symbol: "INFY", token: "1", tradingSymbol: "INFY", segment: "nse_cm", side: "buy", qty: 2,
    price: 100, kind: "entry", tif: "MKT", tag: "manual", decisionId: null, leg: "equity", tier: "B", idempotencyKey: "intent" });
  assert.equal(o.status, "filled");
});

test("fees, slippage and estimated spread are separate and never violate a limit", t => {
  const f = fixture(t, { PAPER_SLIPPAGE_BPS: "2", PAPER_FEE_BPS: "5" });
  const pending = f.paper.submit({ ...buy(), type: "limit", limitPrice: 100 });
  assert.equal(pending.status, "open");
  f.time.set(start + 1000); f.update("INFY", 99.9); f.paper.tick();
  assert.equal(f.paper.order(pending.id).fill_paise, 9995);
  assert.equal(f.paper.order(pending.id).fee_paise, 25);
  const q = f.quotes.get("TCS"); assert.ok(q);
  f.quotes.set("TCS", { ...q, bid: 0, ask: 0, ts: clock.now() });
  assert.ok((f.paper.submit({ ...buy("fallback"), symbol: "TCS" }).fill_paise ?? 0) > 10000);
});

test("failed fill rolls back order, ledger, reservation, and position atomically", t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_fill BEFORE INSERT ON paper_ledger WHEN NEW.kind='buy' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END");
  assert.throws(() => f.paper.submit(buy()), /injected storage failure/);
  assert.equal(f.paper.orders().length, 0);
  assert.equal(f.paper.positions().length, 0);
  assert.equal(f.paper.account().cash, 1_000_000);
  assert.equal(f.paper.ledger().length, 1);
});

test("restart restores pending cash, fill idempotency, positions, and initial deposit exactly once", t => {
  const dir = mkdtempSync(join(tmpdir(), "dipdaemon-paper-"));
  const path = join(dir, "paper.db");
  const f = fixture(t, {}, path);
  const pending = f.paper.submit({ ...buy(), type: "limit", limitPrice: 90 });
  f.db.close();
  const reopened = new Database(path);
  const recovered = new PaperExecutor(reopened, { ...f.settings, initialCapital: 99999 }, () => f.quotes);
  assert.equal(recovered.account().reservedCash, 45000);
  assert.equal(recovered.account().initialCapital, 1_000_000);
  f.time.set(start + 1000); f.update("INFY", 89); recovered.tick();
  assert.equal(recovered.order(pending.id).status, "filled");
  assert.equal(recovered.positions()[0].qty, 5);
  assert.equal(recovered.submit({ ...buy(), type: "limit", limitPrice: 90 }).id, pending.id);
  assert.equal(recovered.ledger().length, 2);
  assert.equal(recovered.submit(sell()).status, "filled");
  reopened.close();
  const closedDb = new Database(path);
  const closedAccount = new PaperExecutor(closedDb, f.settings, () => f.quotes);
  assert.equal(closedAccount.positions().length, 0);
  assert.equal(closedAccount.trades().length, 1);
  assert.equal(closedAccount.ledger().length, 3);
  assert.equal(closedAccount.account().cash, 1_000_000);
  closedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test("manual HTTP workflow, error statuses, origin protection and observe isolation", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dipdaemon-api-"));
  Object.assign(process.env, { DB_PATH: join(dir, "legacy.db"), TRADING_MODE: "paper", MODEL: "mock", HOST: "127.0.0.1" });
  const f = fixture(t);
  const { Engine } = await import("../src/engine.js");
  const { SimBroker } = await import("../src/replay/sim.js");
  const { db } = await import("../src/db.js");
  const { startServer } = await import("../src/server.js");
  const engine = new Engine(new SimBroker(new Map()));
  const server = startServer(engine, undefined, 0, f.paper);
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const send = (path: string, value: unknown, origin?: string) => fetch(`${url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(value),
  });
  try {
    assert.equal((await send("/api/paper/orders", buy())).status, 200);
    assert.equal((await fetch(`${url}/api/paper/positions`)).status, 200);
    f.update("INFY", 110);
    assert.equal((await send("/api/paper/orders", sell())).status, 200);
    const account: unknown = await (await fetch(`${url}/api/paper/account`)).json();
    assert.ok(account && typeof account === "object" && "cash" in account);
    assert.equal(account.cash, 1_005_000);
    assert.equal((await send("/api/paper/orders", buy("invalid", 0))).status, 400);
    assert.equal((await send("/api/paper/orders", buy("cross-site"), "https://malicious.example")).status, 403);
    assert.equal((await send("/api/kill", {}, "https://malicious.example")).status, 403);
    assert.equal((await send("/api/paper/orders", { padding: "x".repeat(17000) })).status, 413);
    assert.equal((await fetch(`${url}/api/paper/orders/1234`)).status, 404);
    const pendingResponse = await send("/api/paper/orders", { ...buy("http-limit"), type: "limit", limitPrice: 90 });
    const pending: unknown = await pendingResponse.json();
    assert.ok(pending && typeof pending === "object" && "id" in pending && typeof pending.id === "string");
    assert.equal((await send(`/api/paper/orders/${pending.id}/modify`, { limitPrice: 91 })).status, 200);
    assert.equal((await send(`/api/paper/orders/${pending.id}/cancel`, {})).status, 200);
    const disabled = startServer(engine, undefined, 0);
    await once(disabled, "listening");
    const disabledAddress = disabled.address(); assert.ok(disabledAddress && typeof disabledAddress !== "string");
    try { assert.equal((await fetch(`http://127.0.0.1:${disabledAddress.port}/api/paper/account`)).status, 409); }
    finally {
      disabled.closeAllConnections();
      await new Promise<void>((resolve, reject) => disabled.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("synthetic demo boots without credentials and serves a complete manual trade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dipdaemon-demo-"));
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/paper-demo.ts"], {
    env: { ...process.env, PORT: "0", PAPER_DEMO_DB_PATH: join(dir, "demo.db") }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let log = "";
  try {
    const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Demo startup timeout: ${log}`)), 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(log);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.stderr.on("data", (chunk: Buffer) => { log += chunk.toString(); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Demo exited ${code}: ${log}`)); });
    });
    const status: unknown = await (await fetch(`${url}/api/market/status`)).json();
    assert.ok(status && typeof status === "object" && "source" in status);
    assert.equal(status.source, "synthetic-fixtures");
    for (const order of [buy("demo-buy", 1), sell("demo-sell", 1)]) {
      const response = await fetch(`${url}/api/paper/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) });
      assert.equal(response.status, 200);
      const result: unknown = await response.json();
      assert.ok(result && typeof result === "object" && "status" in result);
      assert.equal(result.status, "filled");
    }
    const positions: unknown = await (await fetch(`${url}/api/paper/positions`)).json();
    assert.deepEqual(positions, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
