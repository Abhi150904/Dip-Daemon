import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { parseDataset, syntheticDataset } from "../src/backtest/data.js";
import { evaluate, metrics, parseRun, simulate, type Trade } from "../src/backtest/engine.js";
import { Backtests } from "../src/backtest/store.js";
import { clock } from "../src/time.js";
const dataset = syntheticDataset();
const request = { startDate: dataset.dates[0], endDate: dataset.dates.at(-1), holdoutDate: dataset.dates[2], strategies: ["vwap_momentum", "session_hold"], initialCapital: 10000, maxOrderValue: 1000, maxPositions: 3, dailyLossLimit: 300, feeBps: 5, spreadBps: 5, slippageBps: 2, participation: .01 };
const config = parseRun(request, dataset);
test("historical validation rejects missing/duplicate bars, impossible OHLC, invalid universe and incomplete sessions", () => {
    assert.equal(dataset.bars.length, 3000);
    assert.throws(() => parseDataset({ ...dataset, bars: dataset.bars.slice(1) }), /375/);
    assert.throws(() => parseDataset({ ...dataset, bars: dataset.bars.filter(b => b.symbol !== "TCS") }), /TCS/);
    assert.throws(() => parseDataset({ ...dataset, bars: dataset.bars.filter(b => !new Date(b.ts).toISOString().startsWith(dataset.dates[1])) }), /375/);
    assert.throws(() => parseDataset({ ...dataset, bars: [...dataset.bars, dataset.bars[0]] }), /375/);
    assert.throws(() => parseDataset({ ...dataset, bars: [{ ...dataset.bars[0], high: 1 }, ...dataset.bars.slice(1)] }), /OHLCV/);
    assert.throws(() => parseDataset({ ...dataset, universeAsOf: "2026-10-22" }), /Universe/);
    assert.throws(() => parseRun({ ...request, holdoutDate: request.startDate }, dataset), /start/);
    assert.throws(() => parseRun({ ...request, initialCapital: "10000" }, dataset), /capital/);
});
test("repeatable strategy comparisons preserve data, process clock and independent holdout cash", () => {
    const before = JSON.stringify(dataset), now = clock.now;
    const a = evaluate(dataset, config), b = evaluate(dataset, config);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(dataset), before);
    assert.equal(clock.now, now);
    assert.equal(a.results.length, 2);
    for (const r of a.results)
        for (const window of [r.inSample, r.outOfSample]) {
            assert.equal(window.equity[0].equity, config.initialCapital);
            assert.equal(window.equity.at(-1)?.equity, window.metrics.endingEquity);
            assert.equal(window.metrics.grossPnl - window.metrics.totalCosts, window.metrics.netPnl);
            assert.ok(window.metrics.tradeCount > 0);
        }
    assert.notEqual(evaluate(dataset, { ...config, feeBps: 6 }).fingerprint, a.fingerprint);
});
test("VWAP fills at next opening and uses prior volume, never the execution candle's final volume", () => {
    const original = simulate(dataset, config, "vwap_momentum", [dataset.dates[0]]);
    const first = original.trades[0];
    assert.ok(first);
    const bar = dataset.bars.find(b => b.ts === first.openedAt && b.symbol === first.symbol);
    assert.ok(bar);
    assert.equal(first.entryPaise, Math.round(bar.open * 100));
    assert.ok(first.openedAt >= dataset.bars[0].ts + 20 * 60000);
    const altered = parseDataset({ ...dataset, bars: dataset.bars.map(b => b === bar ? { ...b, volume: 1 } : b) });
    const second = simulate(altered, config, "vwap_momentum", [dataset.dates[0]]).trades[0];
    assert.equal(second.openedAt, first.openedAt);
    assert.equal(second.qty, first.qty);
    assert.equal(second.entryPaise, first.entryPaise);
});
test("future price shocks cannot change any earlier marked equity or completed trade", () => {
    const cutoff = dataset.bars[0].ts + 180 * 60000;
    const changed = parseDataset({ ...dataset, bars: dataset.bars.map(b => b.ts >= cutoff ? { ...b, open: b.open * 2, high: b.high * 2, low: b.low * 2, close: b.close * 2 } : b) });
    const a = simulate(dataset, config, "vwap_momentum", [dataset.dates[0]]), b = simulate(changed, config, "vwap_momentum", [dataset.dates[0]]);
    assert.deepEqual(a.equity.filter(p => p.ts <= cutoff), b.equity.filter(p => p.ts <= cutoff));
    assert.deepEqual(a.trades.filter(t => t.closedAt <= cutoff), b.trades.filter(t => t.closedAt <= cutoff));
});
test("stop gaps exit at the worse opening and daily loss halts prevent subsequent entries", () => {
    const base = simulate(dataset, config, "vwap_momentum", [dataset.dates[0]]), first = base.trades[0];
    const gapAt = first.openedAt + 60000;
    const changed = parseDataset({ ...dataset, bars: dataset.bars.map(b => b.ts === gapAt && b.symbol === first.symbol ? { ...b, open: 80, high: 81, low: 79, close: 80 } : b) });
    const run = simulate(changed, { ...config, dailyLossLimit: 1000 }, "vwap_momentum", [dataset.dates[0]]);
    const stopped = run.trades.find(t => t.symbol === first.symbol && t.openedAt === first.openedAt);
    assert.ok(stopped);
    assert.equal(stopped.exitPaise, 8000);
    assert.match(stopped.exitReason, /stop/);
    assert.ok(run.trades.every(t => t.openedAt <= gapAt));
});
test("performance metrics have explicit undefined ratios and match hand-calculated cash results", () => {
    const trade: Trade = { symbol: "INFY", qty: 1, openedAt: 0, closedAt: 600000, entryPaise: 10000, exitPaise: 11000, entryReason: "test", exitReason: "test", grossPnl: 1000, fees: 100, friction: 100, netPnl: 800 };
    const trades = [trade, { ...trade, grossPnl: -200, netPnl: -400 }];
    const m = metrics(trades, [{ ts: 0, equity: 10000, invested: 0 }, { ts: 1, equity: 10800, invested: 0 }, { ts: 2, equity: 10400, invested: 0 }], 10000, .5);
    assert.equal(m.netPnl, 400);
    assert.equal(m.grossPnl, 800);
    assert.equal(m.totalCosts, 400);
    assert.equal(m.winRate, 50);
    assert.equal(m.profitFactor, 2);
    assert.equal(m.expectancy, 200);
    assert.equal(m.maxDrawdown, 400);
    assert.equal(m.maxDrawdownPct, 400 / 10800 * 100);
    assert.equal(m.averageHoldingMinutes, 10);
    assert.equal(m.exposurePct, 50);
    assert.equal(m.returnOnCapitalPct, 4);
    assert.equal(metrics([], [], 10000, 0).profitFactor, null);
    assert.equal(metrics([trade], [], 10000, 1).profitFactorState, "no-losses");
});
test("recorded AI requires causal feature/model cutoffs and cannot use future decisions", () => {
    assert.throws(() => parseRun({ ...request, strategies: ["recorded_ai"] }, dataset), /timestamped/);
    const ts = dataset.bars[0].ts + 30 * 60000;
    const decision = { symbol: "INFY", ts, featureBarTs: ts - 60000, trainingEnd: dataset.bars[0].ts - 1, action: "BUY", stopLoss: 100, modelVersion: "recorded-model-v1", reason: "Archived decision" };
    assert.throws(() => parseDataset({ ...dataset, decisions: [{ ...decision, featureBarTs: ts }] }), /completed/);
    assert.throws(() => parseDataset({ ...dataset, decisions: [{ ...decision, trainingEnd: ts }] }), /training/);
    const withAI = parseDataset({ ...dataset, decisions: [decision] });
    const run = simulate(withAI, config, "recorded_ai", [dataset.dates[0]]);
    assert.equal(run.trades.length, 1);
    assert.equal(run.trades[0].openedAt, ts);
    assert.match(run.trades[0].entryReason, /recorded-model-v1/);
    assert.ok(run.equity.filter(p => p.ts < ts).every(p => p.invested === 0));
});
test("persisted runs deduplicate by full fingerprint and do not mutate paper records", async () => {
    const db = new Database(":memory:");
    try {
        db.exec("CREATE TABLE paper_sentinel(cash INTEGER); INSERT INTO paper_sentinel VALUES(123456)");
        const store = new Backtests(db), saved = store.demo();
        let eventLoopRan = false;
        setImmediate(() => { eventLoopRan = true; });
        const pending = store.run({ ...request, datasetId: saved.id });
        await assert.rejects(store.run({ ...request, feeBps: 6, datasetId: saved.id }), /already running/);
        const a = objectResult(await pending);
        assert.equal(eventLoopRan, true, "Evaluation must not monopolize the server event loop");
        const b = objectResult(await store.run({ ...request, datasetId: saved.id }));
        assert.equal(a.id, b.id);
        assert.equal(store.runs().length, 1);
        assert.deepEqual(store.result(String(a.id)), a);
        assert.deepEqual(db.prepare("SELECT cash FROM paper_sentinel").get(), { cash: 123456 });
        assert.throws(() => store.result("missing"), /not found/);
    }
    finally {
        db.close();
    }
});
function objectResult(raw: unknown) { assert.ok(raw && typeof raw === "object"); return Object.fromEntries(Object.entries(raw)); }
