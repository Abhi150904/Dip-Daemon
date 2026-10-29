import assert from "node:assert/strict";
import { test, after, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import Database from "better-sqlite3";
import { PaperExecutor } from "../src/executor/paper.js";
import { PaperAutomation } from "../src/automation/paper.js";
import { paperSettings } from "../src/portfolio/types.js";
import { automationSettings, baselineSignal, completedBars, type AutomationSettings } from "../src/strategy/signals.js";
import { parseEvaluation, validEvaluation } from "../src/model/validation.js";
import { clock, useVirtualClock } from "../src/time.js";
import type { Bar, Quote } from "../src/types.js";
import type { Model, EvalResult } from "../src/model/index.js";
import type { StrategySnapshot } from "../src/strategy/ai-paper.js";
import type { Question } from "../src/model/questions.js";

const scratch = mkdtempSync(join(tmpdir(), "dipdaemon-automation-"));
Object.assign(process.env, { DB_PATH: join(scratch, "models.db"), TRADING_MODE: "paper", MODEL: "mock", HOST: "127.0.0.1",
  RSS_FEEDS: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", PAPER_AUTOMATION_MODE: "off", PAPER_STRATEGY: "vwap_momentum", AI_GATEWAY_API_KEY: "", TYPESAFE_AI_API_KEY: "" });
const { db: legacyDb, upsertBar } = await import("../src/db.js");
const { buildFeatures, buildIndexFeatures } = await import("../src/data/features.js");
const { MockModel } = await import("../src/model/mock.js");
after(() => { legacyDb.close(); rmSync(scratch, { recursive: true, force: true }); });
const start = Date.parse("2026-10-29T04:15:00Z");

class FixtureModel extends MockModel {
  override name = "jev";
  fail: "none" | "throw" | "stage1" | "stage2" | "timeout" | "exit" = "none";
  override async evaluate(state: unknown, questions: Record<string, Question>, stage: string, symbol: string | null = null): Promise<EvalResult> {
    if (this.fail === "throw") throw new Error("fixture provider failed");
    if (this.fail === "timeout") return new Promise(() => {});
    const result = await super.evaluate(state, questions, stage, symbol);
    result.modelId = "fixture-jev-v1";
    if (stage === "stage1" && this.fail === "stage1") delete result.answers.risk_off;
    if (stage === "stage2" && this.fail === "stage2") result.answers.trend_quality.score = Infinity;
    if (stage === "paper-position" && this.fail === "exit") result.answers.thesis.score = 0;
    return result;
  }
}

function fixture(t: TestContext, changes: Partial<AutomationSettings> = {}, paperEnv: NodeJS.ProcessEnv = {}, path = ":memory:") {
  const time = useVirtualClock(start);
  legacyDb.exec("DELETE FROM bars_1m");
  const db = new Database(path);
  const quotes = new Map<string, Quote>();
  let bars: Bar[] = [];
  let killed = false;
  const update = (now = clock.now(), falling = false, price = falling ? 99.9 : 100.05) => {
    bars = Array.from({ length: 30 }, (_, i) => {
      const close = i < 26 ? 99.9 : (falling ? [100.1, 100.05, 100, 99.9][i - 26] : [99.85, 99.88, 99.94, 100][i - 26]);
      return { symbol: "INFY", ts: now - (30 - i) * 60000, open: close - 0.01, high: close + 0.1, low: close - 0.1, close, volume: i === 29 ? 2000 : 1000 };
    });
    for (const b of bars) upsertBar(b);
    quotes.set("INFY", { symbol: "INFY", token: "INFY", segment: "nse_cm", ts: now, ltp: price, bid: price, ask: price,
      tickSize: 0.05, ltq: 1, volume: 20000, tbq: 200, tsq: 100, bids: [{ price, qty: 100 }], asks: [{ price, qty: 100 }],
      open: price, high: price, low: price, close: price });
  };
  update();
  const paper = new PaperExecutor(db, paperSettings({ PAPER_FEE_BPS: "0", PAPER_SLIPPAGE_BPS: "0", ...paperEnv }), () => quotes, () => killed);
  const model = new FixtureModel();
  const snapshot = (): StrategySnapshot => {
    const q = quotes.get("INFY"); assert.ok(q);
    const feature = buildFeatures("INFY", q); assert.ok(feature);
    return { source: "offline-test", quotes: [q], bars: new Map([["INFY", bars]]), features: [feature], index: buildIndexFeatures({ ...q, symbol: "Nifty 50", ltp: 24000 }, 0, 1), indexTs: q.ts };
  };
  const settings = automationSettings(changes);
  const automation = new PaperAutomation(db, paper, snapshot, model, settings);
  t.after(() => { if (db.open) db.close(); clock.now = () => Date.now(); });
  return { db, paper, quotes, model, automation, update, snapshot, settings, time, kill: () => { killed = true; } };
}

test("provider parsing rejects missing, nonfinite, coerced and invalid choice answers", () => {
  const questions: Record<string, Question> = { probability: { type: "noul", instructions: "" }, score: { type: "score", instructions: "", criteria: ["bad", "good"] }, choice: { type: "choice", instructions: "", criteria: { yes: null, no: null } } };
  const good = () => ({ model: "fixture-v1", answers: { probability: { probability: 0.7 }, score: { score: 0.5 }, choice: { choice: "yes", probabilities: { yes: 0.7, no: 0.3 }, confidence: 0.8 } } });
  const parsed = parseEvaluation(good(), questions);
  assert.equal(validEvaluation({ ...parsed, ok: true, latencyMs: 1 }, questions), true);
  assert.throws(() => parseEvaluation({ answers: {} }, questions));
  for (const value of [NaN, Infinity, -0.1, 1.1, "0.7"]) {
    const raw = good();
    assert.throws(() => parseEvaluation({ ...raw, answers: { ...raw.answers, probability: { probability: value } } }, questions));
  }
  const raw = good(); raw.answers.choice.choice = "invented";
  assert.throws(() => parseEvaluation(raw, questions));
  const sum = good(); sum.answers.choice.probabilities.no = 0.7;
  assert.throws(() => parseEvaluation(sum, questions));
});

test("model selection and AI risk configuration fail closed", async t => {
  const { parseModelName, risk } = await import("../src/config.js");
  assert.throws(() => parseModelName("not-jev"), /MODEL/);
  const f = fixture(t, { mode: "automatic", strategy: "jev" });
  const previous = risk.maxSpreadBps;
  try {
    risk.maxSpreadBps = NaN;
    await f.automation.scan();
    assert.equal(f.paper.orders().length, 0);
    assert.equal(f.db.prepare<[], { reason: string }>("SELECT reason FROM paper_strategy_runs").get()?.reason, "Invalid inherited AI risk thresholds");
  } finally { risk.maxSpreadBps = previous; }
});

test("baseline is explicit and ignores future/incomplete bars", t => {
  const f = fixture(t);
  const snapshot = f.snapshot();
  const q = snapshot.quotes[0];
  const bars = snapshot.bars.get("INFY"); assert.ok(bars);
  assert.equal(baselineSignal(q, bars, f.settings, start, false).action, "BUY");
  const future = { ...bars[0], ts: start, close: 999999, high: 999999 };
  assert.deepEqual(baselineSignal(q, [...bars, future], f.settings, start, false), baselineSignal(q, bars, f.settings, start, false));
  assert.throws(() => completedBars(bars.slice(-10), "INFY", start));
  const broken = bars.map(b => ({ ...b })); broken[10].volume = NaN;
  assert.throws(() => completedBars(broken, "INFY", start));
});

test("observe/off scans log decisions without creating orders", async t => {
  const f = fixture(t);
  await f.automation.scan();
  assert.equal(f.automation.signals()[0].status, "observed");
  assert.equal(f.paper.orders().length, 0);
  const observeDb = new Database(":memory:");
  const observe = new PaperAutomation(observeDb, undefined, f.snapshot, f.model);
  await observe.scan();
  assert.equal(observe.signals()[0].status, "observed");
  assert.throws(() => observe.configure({ mode: "automatic" }), /TRADING_MODE/);
  assert.equal(observeDb.prepare("SELECT name FROM sqlite_master WHERE name='paper_orders'").get(), undefined);
  observeDb.close();
});

test("approval mode requires approval, then executes once with traceable accounting", async t => {
  const f = fixture(t, { mode: "approval" });
  await f.automation.scan();
  const signal = f.automation.signals()[0];
  assert.equal(signal.status, "pending");
  assert.equal(f.paper.orders().length, 0);
  const result = f.automation.approve(signal.id);
  assert.equal(result.status, "ordered");
  assert.ok(result.order_id);
  assert.equal(f.automation.approve(signal.id).order_id, result.order_id);
  assert.equal(f.paper.orders().length, 1);
  assert.equal(f.paper.positions()[0].entry_order_id, result.order_id);
  assert.ok(f.automation.events().length >= 3);
});

test("approval rejects expired, stale, drifting and disabled signals", async t => {
  for (const scenario of ["expired", "stale", "drift", "disabled"] as const) {
    const f = fixture(t, { mode: "approval" });
    await f.automation.scan(); const signal = f.automation.signals()[0];
    if (scenario === "expired") f.time.set(start + 61000);
    if (scenario === "stale") f.time.set(start + 16000);
    if (scenario === "drift") f.update(start, false, 103);
    if (scenario === "disabled") {
      f.automation.configure({ mode: "off" });
      assert.throws(() => f.automation.approve(signal.id), /pending/);
    } else assert.equal(f.automation.approve(signal.id).status, "rejected");
    assert.equal(f.paper.orders().length, 0);
  }
});

test("automatic baseline enters, monitors and closes a virtual position; cooldown prevents immediate reentry", async t => {
  const f = fixture(t, { mode: "automatic" });
  await f.automation.tick();
  assert.equal(f.paper.positions().length, 1);
  f.time.set(start + 60000); f.update(clock.now(), true);
  await f.automation.tick();
  assert.equal(f.paper.positions().length, 0);
  assert.equal(f.paper.trades().length, 1);
  f.time.set(start + 120000); f.update();
  await f.automation.tick();
  assert.equal(f.paper.positions().length, 0);
  assert.ok(f.automation.signals().some(s => /cooling/.test(s.reason)));
  const account = f.paper.account();
  assert.equal(account.equity, account.initialCapital + account.realizedPnl);
});

test("same completed-bar signals are deduplicated and user rejection is terminal", async t => {
  const f = fixture(t, { mode: "approval" });
  await f.automation.scan(); await f.automation.scan();
  assert.equal(f.automation.signals().length, 1);
  const signal = f.automation.signals()[0]; f.automation.reject(signal.id);
  assert.throws(() => f.automation.approve(signal.id), /not pending/);
  assert.equal(f.paper.orders().length, 0);
});

test("automation does not sell manually opened positions", async t => {
  const f = fixture(t, { mode: "automatic" });
  f.paper.submit({ idempotencyKey: "manual", symbol: "INFY", side: "buy", qty: 1, type: "market" });
  f.time.set(start + 60000); f.update(clock.now(), true);
  await f.automation.scan();
  assert.equal(f.paper.positions().length, 1);
  assert.equal(f.paper.trades().length, 0);
});

test("kill and insufficient funds cannot be overridden by a high strategy score", async t => {
  const f = fixture(t, { mode: "automatic" }, { PAPER_INITIAL_CAPITAL: "10" });
  await f.automation.scan(); assert.equal(f.paper.positions().length, 0);
  const killed = fixture(t, { mode: "automatic" }); killed.kill();
  await killed.automation.scan(); assert.equal(killed.paper.positions().length, 0);
  assert.ok(killed.automation.signals().some(s => /risk halt/.test(s.reason)));
});

test("two-stage Jev adapter produces validated paper entry and model-driven exit", async t => {
  const f = fixture(t, { mode: "automatic", strategy: "jev" });
  await f.automation.scan();
  assert.equal(f.paper.positions().length, 1, JSON.stringify({ runs: f.automation.runs(), signals: f.automation.signals() }));
  const signal = f.automation.signals()[0]; assert.equal(signal.signal.modelVersion, "fixture-jev-v1");
  f.model.fail = "exit"; f.time.set(start + 60000); f.update();
  await f.automation.scan();
  assert.equal(f.paper.positions().length, 0, JSON.stringify(f.automation.runs()));
  assert.equal(f.paper.trades().length, 1);
});

test("model errors, invalid stages and timeouts create no orders", async t => {
  for (const fail of ["throw", "stage1", "stage2", "timeout"] as const) {
    const f = fixture(t, { mode: "automatic", strategy: "jev", modelTimeoutMs: fail === "timeout" ? 20 : 10000 });
    f.model.fail = fail;
    await f.automation.scan();
    assert.equal(f.paper.orders().length, 0, fail);
    assert.equal(f.db.prepare<[], { status: string }>("SELECT status FROM paper_strategy_runs").get()?.status, "failed", fail);
  }
});

test("policy changes during model work discard the entire in-flight scan", async t => {
  const f = fixture(t, { mode: "automatic", strategy: "jev" });
  const scan = f.automation.scan();
  f.automation.configure({ mode: "off" });
  await scan;
  assert.equal(f.paper.orders().length, 0);
  assert.equal(f.automation.signals().length, 0);
});

test("late model results after timeout never create signals or orders", { timeout: 3000 }, async t => {
  const f = fixture(t);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let done = () => {};
  const completed = new Promise<void>(resolve => { done = resolve; });
  const model: Model = { name: "jev", evaluate: async (...args) => {
    await gate;
    const result = await f.model.evaluate(...args);
    if (args[2] === "stage2") done();
    return result;
  } };
  const automation = new PaperAutomation(f.db, f.paper, f.snapshot, model, automationSettings({ mode: "automatic", strategy: "jev", modelTimeoutMs: 20 }));
  await automation.scan(); release(); await completed;
  assert.equal(f.paper.orders().length, 0);
  assert.equal(automation.signals().length, 0);
});

test("AI regime evaluation rejects stale index data before invoking the model", async t => {
  const f = fixture(t);
  let calls = 0;
  const model: Model = { name: "jev", evaluate: async (...args) => { calls++; return f.model.evaluate(...args); } };
  const automation = new PaperAutomation(f.db, f.paper, () => ({ ...f.snapshot(), indexTs: start - 20000 }), model, automationSettings({ mode: "automatic", strategy: "jev" }));
  await automation.scan();
  assert.equal(calls, 0);
  assert.equal(f.paper.orders().length, 0);
});

test("approval rechecks stop distance even when price drift is inside its tolerance", async t => {
  const f = fixture(t, { mode: "approval", maxStopBps: 40 });
  await f.automation.scan(); const signal = f.automation.signals()[0];
  assert.equal(signal.status, "pending");
  f.update(start, false, 100.25);
  const result = f.automation.approve(signal.id);
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /stop distance/);
  assert.equal(f.paper.orders().length, 0);
});

test("restart preserves orders/cooldown and invalidates pending approvals without refunding the account", async t => {
  const dir = mkdtempSync(join(scratch, "restart-"));
  const path = join(dir, "paper.db");
  const f = fixture(t, { mode: "automatic" }, {}, path);
  await f.automation.scan();
  const orderCount = f.paper.orders().length; const cash = f.paper.account().cash;
  f.db.close();
  const reopened = new Database(path);
  const paper = new PaperExecutor(reopened, f.paper.settings, () => f.quotes);
  const automation = new PaperAutomation(reopened, paper, f.snapshot, f.model);
  assert.equal(automation.config().settings.mode, "off");
  assert.equal(paper.account().cash, cash);
  assert.equal(paper.orders().length, orderCount);
  assert.ok(reopened.prepare("SELECT * FROM paper_cooldowns WHERE symbol='INFY'").get());
  reopened.close();
  const pending = fixture(t, { mode: "approval" }); await pending.automation.scan();
  const restarted = new PaperAutomation(pending.db, pending.paper, pending.snapshot, pending.model);
  assert.equal(restarted.signals()[0].status, "expired");
  assert.equal(pending.paper.orders().length, 0);
});

test("Phase 1 position migration preserves manual holdings and cash without claiming strategy ownership", t => {
  const f = fixture(t);
  f.paper.submit({ idempotencyKey: "old-manual", symbol: "INFY", side: "buy", type: "market", qty: 1 });
  const cash = f.paper.account().cash;
  f.db.exec("ALTER TABLE paper_positions DROP COLUMN entry_order_id");
  const upgraded = new PaperExecutor(f.db, f.paper.settings, () => f.quotes);
  assert.equal(upgraded.account().cash, cash);
  assert.equal(upgraded.positions()[0].qty, 1);
  assert.equal(upgraded.positions()[0].entry_order_id, null);
});

test("maximum holding time creates an exit even while the baseline remains positive", async t => {
  const f = fixture(t, { mode: "automatic", maxHoldMinutes: 1 });
  await f.automation.scan();
  f.time.set(start + 60000); f.update();
  await f.automation.scan();
  assert.equal(f.paper.positions().length, 0);
  assert.ok(f.automation.signals().some(s => /holding time/.test(s.signal.reason)));
});

test("account loss and position limits still reject otherwise valid automation signals", async t => {
  const f = fixture(t, { mode: "approval" });
  await f.automation.scan();
  const signal = f.automation.signals()[0];
  f.paper.wallet.db.prepare("INSERT INTO paper_days(date,start_equity_paise,halted) VALUES ('2026-10-29',1000000,1) ON CONFLICT(date) DO UPDATE SET halted=1").run();
  assert.equal(f.automation.approve(signal.id).status, "rejected");
  assert.equal(f.paper.orders().length, 0);
  const capped = fixture(t, { mode: "approval" }, { PAPER_MAX_POSITIONS: "1" });
  await capped.automation.scan();
  const q = capped.quotes.get("INFY"); assert.ok(q);
  capped.quotes.set("TCS", { ...q, symbol: "TCS", token: "TCS" });
  capped.paper.submit({ idempotencyKey: "occupy", symbol: "TCS", side: "buy", type: "market", qty: 1 });
  assert.equal(capped.automation.approve(capped.automation.signals()[0].id).status, "rejected");
  assert.equal(capped.paper.positions().length, 1);
});

test("order and signal links roll back together if audit persistence fails", async t => {
  const f = fixture(t, { mode: "approval" });
  await f.automation.scan(); const signal = f.automation.signals()[0];
  const cash = f.paper.account().cash;
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON paper_signal_events WHEN NEW.kind='ordered' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.throws(() => f.automation.approve(signal.id), /audit failure/);
  assert.equal(f.paper.orders().length, 0);
  assert.equal(f.paper.positions().length, 0);
  assert.equal(f.paper.account().cash, cash);
  assert.equal(f.automation.signals()[0].status, "pending");
  f.db.exec("DROP TRIGGER fail_audit");
  assert.equal(f.automation.approve(signal.id).status, "ordered");
});

test("scheduler respects scan interval, market hours and off mode", async t => {
  const f = fixture(t, { mode: "automatic" });
  await f.automation.tick(); await f.automation.tick();
  assert.equal(f.automation.runs().length, 1);
  f.time.set(start + 1000); f.update(); await f.automation.tick();
  assert.equal(f.automation.runs().length, 1);
  f.automation.configure({ mode: "off" });
  f.time.set(start + 60000); f.update(); await f.automation.tick();
  assert.equal(f.automation.runs().length, 1);
  f.automation.configure({ mode: "automatic" });
  f.time.set(Date.parse("2026-10-29T10:30:00Z")); await f.automation.tick();
  assert.equal(f.automation.runs().length, 1);
});

test("initial run persistence failure releases the scan guard and permits a safe retry", async t => {
  const f = fixture(t, { mode: "automatic" });
  f.db.exec("CREATE TRIGGER fail_run BEFORE INSERT ON paper_strategy_runs BEGIN SELECT RAISE(ABORT,'run storage failure'); END");
  await assert.rejects(f.automation.scan(), /Could not persist strategy run/);
  assert.equal(f.automation.status().scanning, false);
  assert.equal(f.paper.orders().length, 0);
  f.db.exec("DROP TRIGGER fail_run");
  await f.automation.scan();
  assert.equal(f.paper.positions().length, 1);
});

test("HTTP strategy controls require local origin and drive approved entry/exit", async t => {
  const f = fixture(t);
  const { Engine } = await import("../src/engine.js");
  const { SimBroker } = await import("../src/replay/sim.js");
  const { startServer } = await import("../src/server.js");
  const server = startServer(new Engine(new SimBroker(new Map())), undefined, 0, f.paper, f.automation);
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, value: unknown = {}, origin?: string) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(value) });
  try {
    assert.equal((await fetch(`${url}/api/strategies`)).status, 200);
    assert.equal((await post("/api/automation/config", { mode: "automatic" }, "https://bad.example")).status, 403);
    assert.equal((await post("/api/automation/config", { mode: "live" })).status, 400);
    assert.equal((await post("/api/automation/config", { mode: "approval" })).status, 200);
    assert.equal((await post("/api/automation/scan")).status, 200);
    const buySignal = f.automation.signals()[0];
    assert.equal((await post(`/api/signals/${buySignal.id}/approve`)).status, 200);
    assert.equal(f.paper.positions().length, 1);
    f.time.set(start + 60000); f.update(clock.now(), true);
    await post("/api/automation/scan");
    const sellSignal = f.automation.signals().find(s => s.action === "SELL"); assert.ok(sellSignal);
    assert.equal((await post(`/api/signals/${sellSignal.id}/approve`)).status, 200);
    assert.equal(f.paper.positions().length, 0);
    assert.equal((await fetch(`${url}/api/automation/runs`)).status, 200);
    assert.equal((await fetch(`${url}/api/automation/events`)).status, 200);
    assert.equal((await post("/api/signals/1234/approve")).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
