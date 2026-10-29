import { createHash } from "node:crypto";
import { paise, PaperError } from "../portfolio/types.js";
import { automationSettings, baselineSignal } from "../strategy/signals.js";
import { istDateStr, minutesOfDay } from "../time.js";
import type { Bar, Quote } from "../types.js";
import { date, numeric, object, type Dataset } from "./data.js";
export const evaluationVersion = "next-open-intraday-v1";
export type Strategy = "vwap_momentum" | "session_hold" | "recorded_ai";
export function parseRun(raw: unknown, dataset: Dataset) {
    const input = object(raw), startDate = date(input.startDate), endDate = date(input.endDate), holdoutDate = date(input.holdoutDate);
    if (startDate >= holdoutDate || holdoutDate > endDate || ![startDate, holdoutDate, endDate].every(d => dataset.dates.includes(d)))
        throw new PaperError("Choose dataset sessions with start < holdout ≤ end", 400);
    if (!Array.isArray(input.strategies) || !input.strategies.length || input.strategies.length > 3)
        throw new PaperError("Select 1–3 strategies", 400);
    const strategies: Strategy[] = input.strategies.map(s => {
        if (s !== "vwap_momentum" && s !== "session_hold" && s !== "recorded_ai")
            throw new PaperError("Unknown evaluation strategy", 400);
        if (s === "recorded_ai" && !dataset.decisions.length)
            throw new PaperError("Import timestamped AI decisions before selecting recorded_ai", 400);
        return s;
    });
    if (new Set(strategies).size !== strategies.length)
        throw new PaperError("Duplicate strategy", 400);
    return { startDate, endDate, holdoutDate, strategies,
        initialCapital: paise(numeric(input.initialCapital, "starting capital INR", 100, 1e7)),
        maxOrderValue: paise(numeric(input.maxOrderValue, "maximum order INR", 1, 1e7)),
        maxPositions: integer(input.maxPositions, "maximum positions", 1, 20),
        dailyLossLimit: paise(numeric(input.dailyLossLimit, "daily loss limit INR", 1, 1e7)),
        feeBps: numeric(input.feeBps, "estimated fee bps", 0, 100),
        spreadBps: numeric(input.spreadBps, "full spread bps", 0, 100),
        slippageBps: numeric(input.slippageBps, "slippage bps", 0, 100),
        participation: numeric(input.participation, "maximum volume participation", .001, .1),
        parameters: automationSettings(input.parameters ?? {}) };
}
function integer(raw: unknown, name: string, min: number, max: number) { const n = numeric(raw, name, min, max); if (!Number.isSafeInteger(n))
    throw new PaperError(`Invalid whole number ${name}`, 400); return n; }
export type RunConfig = ReturnType<typeof parseRun>;
export interface Trade {
    symbol: string;
    qty: number;
    openedAt: number;
    closedAt: number;
    entryPaise: number;
    exitPaise: number;
    entryReason: string;
    exitReason: string;
    grossPnl: number;
    fees: number;
    friction: number;
    netPnl: number;
}
interface Position {
    symbol: string;
    qty: number;
    entry: number;
    entryFee: number;
    entryFriction: number;
    openedAt: number;
    reason: string;
    stop: number | null;
}
type Intent = {
    side: "BUY";
    stop: number | null;
    reason: string;
} | {
    side: "SELL";
    reason: string;
};
export interface Point {
    ts: number;
    equity: number;
    invested: number;
}
const roundPrice = (price: number) => Math.round(price * 100);
function quote(bar: Bar): Quote {
    return { ...bar, token: bar.symbol, segment: "nse_cm", ts: bar.ts + 60000, ltp: bar.close, ltq: 0, bid: bar.close, ask: bar.close, tbq: 0, tsq: 0, bids: [], asks: [], tickSize: .05 };
}
export function metrics(trades: Trade[], equity: Point[], initialCapital: number, exposure: number) {
    const netPnl = trades.reduce((sum, t) => sum + t.netPnl, 0), grossPnl = trades.reduce((sum, t) => sum + t.grossPnl, 0);
    const winners = trades.filter(t => t.netPnl > 0), losers = trades.filter(t => t.netPnl < 0);
    const won = winners.reduce((s, t) => s + t.netPnl, 0), lost = -losers.reduce((s, t) => s + t.netPnl, 0);
    let peak = initialCapital, maxDrawdown = 0, maxDrawdownPct = 0;
    for (const p of equity) {
        peak = Math.max(peak, p.equity);
        maxDrawdown = Math.max(maxDrawdown, peak - p.equity);
        maxDrawdownPct = Math.max(maxDrawdownPct, (peak - p.equity) / peak * 100);
    }
    const fees = trades.reduce((s, t) => s + t.fees, 0), friction = trades.reduce((s, t) => s + t.friction, 0);
    return { grossPnl, netPnl, fees, friction, totalCosts: fees + friction, tradeCount: trades.length, winRate: trades.length ? winners.length / trades.length * 100 : null,
        averageWin: winners.length ? won / winners.length : null, averageLoss: losers.length ? -lost / losers.length : null,
        profitFactor: lost ? won / lost : null, profitFactorState: lost ? "finite" : won ? "no-losses" : "no-trades-or-flat",
        expectancy: trades.length ? netPnl / trades.length : null, maxDrawdown, maxDrawdownPct,
        averageHoldingMinutes: trades.length ? trades.reduce((s, t) => s + (t.closedAt - t.openedAt) / 60000, 0) / trades.length : null,
        exposurePct: exposure * 100, returnOnCapitalPct: netPnl / initialCapital * 100, endingEquity: initialCapital + netPnl };
}
/** Local state only: never changes the process clock, broker, paper wallet or live settings. */
export function simulate(dataset: Dataset, config: RunConfig, strategy: Strategy, days: string[]) {
    let cash = config.initialCapital, lastDay = "", startEquity = cash, halted = false, exposed = 0, exposureSlots = 0;
    const positions = new Map<string, Position>(), pending = new Map<string, Intent>(), history = new Map<string, Bar[]>(), marks = new Map<string, number>(), cooldown = new Map<string, number>();
    const trades: Trade[] = [], equity: Point[] = [], events: {
        ts: number;
        symbol: string;
        reason: string;
    }[] = [];
    const daySet = new Set(days), rows = dataset.bars.filter(b => daySet.has(istDateStr(b.ts)));
    const byTime = new Map<number, Bar[]>();
    for (const b of rows) {
        const group = byTime.get(b.ts) ?? [];
        group.push(b);
        byTime.set(b.ts, group);
    }
    const decisions = new Map<string, typeof dataset.decisions>();
    for (const d of dataset.decisions) {
        const opening = Math.ceil(d.ts / 60000) * 60000, key = `${d.symbol}:${opening}`;
        const group = decisions.get(key) ?? [];
        group.push(d);
        decisions.set(key, group);
    }
    const costs = (price: number, qty: number) => { const value = price * qty; return { fee: Math.ceil(value * config.feeBps / 10000), friction: Math.ceil(value * (config.spreadBps / 2 + config.slippageBps) / 10000) }; };
    const value = () => cash + [...positions.values()].reduce((sum, p) => sum + p.qty * (marks.get(p.symbol) ?? p.entry), 0);
    const close = (p: Position, bar: Bar, rawPrice: number, reason: string, ts: number) => {
        const price = roundPrice(rawPrice), c = costs(price, p.qty);
        cash += price * p.qty - c.fee - c.friction;
        const grossPnl = (price - p.entry) * p.qty, fees = c.fee + p.entryFee, friction = c.friction + p.entryFriction;
        trades.push({ symbol: p.symbol, qty: p.qty, openedAt: p.openedAt, closedAt: ts, entryPaise: p.entry, exitPaise: price, entryReason: p.reason, exitReason: reason, grossPnl, fees, friction, netPnl: grossPnl - fees - friction });
        positions.delete(bar.symbol);
        cooldown.set(bar.symbol, ts + config.parameters.cooldownS * 1000);
    };
    for (const [ts, bars] of byTime) {
        const day = istDateStr(ts), minute = minutesOfDay(ts);
        if (day !== lastDay) {
            history.clear();
            pending.clear();
            marks.clear();
            cooldown.clear();
            lastDay = day;
            startEquity = cash;
            halted = false;
            equity.push({ ts, equity: cash, invested: 0 });
        }
        // Apply only prices observable at this opening; a complete bar has not been seen by the strategy yet.
        for (const b of bars)
            marks.set(b.symbol, roundPrice(b.open));
        for (const b of bars) {
            let intent = pending.get(b.symbol);
            pending.delete(b.symbol);
            if (strategy === "session_hold" && minute === 555)
                intent = { side: "BUY", stop: null, reason: "Session opening buy-and-hold benchmark" };
            if (strategy === "recorded_ai") {
                for (const d of decisions.get(`${b.symbol}:${ts}`) ?? []) {
                    if (d.action === "BUY")
                        intent = { side: "BUY", stop: d.stopLoss, reason: `${d.modelVersion}: ${d.reason}` };
                    if (d.action === "SELL")
                        intent = { side: "SELL", reason: `${d.modelVersion}: ${d.reason}` };
                }
            }
            const held = positions.get(b.symbol);
            if (intent?.side === "SELL" && held)
                close(held, b, b.open, intent.reason, ts);
            else if (intent?.side === "BUY" && !held && !halted && minute < 910) {
                const price = roundPrice(b.open), ceiling = Math.min(config.maxOrderValue, cash);
                let qty = Math.floor(ceiling / (price * (1 + (config.feeBps + config.spreadBps / 2 + config.slippageBps) / 10000)));
                while (qty > 0 && price * qty + costs(price, qty).fee + costs(price, qty).friction > ceiling)
                    qty--;
                // Current minute volume is unknown at the opening: use the PREVIOUS completed minute, not b.volume.
                const priorVolume = history.get(b.symbol)?.at(-1)?.volume ?? 0;
                const volumeBudget = strategy === "session_hold" && minute === 555 ? 0 : Math.floor(priorVolume * config.participation);
                const invalidStop = intent.stop !== null && (intent.stop >= b.open || (b.open - intent.stop) / b.open * 10000 > config.parameters.maxStopBps);
                if (!qty || positions.size >= config.maxPositions || invalidStop || (volumeBudget > 0 && qty > volumeBudget) || (!volumeBudget && minute !== 555))
                    events.push({ ts, symbol: b.symbol, reason: "Entry rejected: cash, slots, prior-volume participation or stop-distance limit" });
                else {
                    const c = costs(price, qty);
                    cash -= price * qty + c.fee + c.friction;
                    positions.set(b.symbol, { symbol: b.symbol, qty, entry: price, entryFee: c.fee, entryFriction: c.friction, openedAt: ts, reason: intent.reason, stop: intent.stop });
                }
            }
        }
        const occupiedAtOpen = positions.size > 0;
        for (const b of bars) {
            const p = positions.get(b.symbol);
            if (p) {
                // A resting protective stop can execute during this bar; a gap executes at the worse opening.
                if (p.stop !== null && b.low <= p.stop)
                    close(p, b, Math.min(b.open, p.stop), "protective stop (intrabar order assumed)", ts + 60000);
                else if (minute === 929)
                    close(p, b, b.close, "session close liquidation", ts + 60000);
                else if (halted || ts - p.openedAt >= config.parameters.maxHoldMinutes * 60000 && strategy !== "session_hold")
                    pending.set(b.symbol, { side: "SELL", reason: halted ? "daily loss halt" : "maximum holding time" });
            }
            marks.set(b.symbol, roundPrice(b.close));
            const series = history.get(b.symbol) ?? [];
            series.push(b);
            history.set(b.symbol, series);
        }
        const marked = value();
        if (startEquity - marked >= config.dailyLossLimit) {
            halted = true;
            for (const p of positions.values())
                pending.set(p.symbol, { side: "SELL", reason: "daily loss halt; next open" });
        }
        equity.push({ ts: ts + 60000, equity: marked, invested: [...positions.values()].reduce((sum, p) => sum + p.qty * (marks.get(p.symbol) ?? p.entry), 0) });
        exposed += occupiedAtOpen ? 1 : 0;
        exposureSlots++;
        if (strategy === "vwap_momentum" && minute < 909 && !halted)
            for (const b of bars) {
                const series = history.get(b.symbol) ?? [];
                if (series.length < 20)
                    continue;
                const decision = baselineSignal(quote(b), series, config.parameters, ts + 60000, positions.has(b.symbol));
                if (decision.action === "BUY" && decision.score >= config.parameters.minScore && (cooldown.get(b.symbol) ?? 0) <= ts + 60000)
                    pending.set(b.symbol, { side: "BUY", stop: decision.stopLoss, reason: decision.reason });
                if (decision.action === "SELL")
                    pending.set(b.symbol, { side: "SELL", reason: decision.reason });
            }
    }
    if (positions.size)
        throw new Error("Evaluation ended with unliquidated positions");
    return { dates: days, metrics: metrics(trades, equity, config.initialCapital, exposureSlots ? exposed / exposureSlots : 0), trades, equity, rejectedEntries: events };
}
export function fingerprint(dataset: Dataset, config: RunConfig): string {
    return createHash("sha256").update(JSON.stringify([evaluationVersion, dataset.hash, config])).digest("hex");
}
export function evaluate(dataset: Dataset, config: RunConfig) {
    const training = dataset.dates.filter(d => d >= config.startDate && d < config.holdoutDate), holdout = dataset.dates.filter(d => d >= config.holdoutDate && d <= config.endDate);
    const results = config.strategies.map(strategy => ({ strategy, strategyVersion: strategy === "vwap_momentum" ? "vwap-momentum-v1" : strategy === "session_hold" ? "session-hold-v1" : "recorded-decisions-v1",
        modelVersions: strategy === "recorded_ai" ? [...new Set(dataset.decisions.map(d => d.modelVersion))] : ["deterministic-v1"],
        inSample: simulate(dataset, config, strategy, training), outOfSample: simulate(dataset, config, strategy, holdout) }));
    return { fingerprint: fingerprint(dataset, config), version: evaluationVersion, datasetHash: dataset.hash, config, results,
        assumptions: ["Long-only, whole shares; intraday positions liquidated at each session close; equal starting capital in independent in-sample and holdout windows.", "VWAP sees only completed bars; decisions fill next open. Stop gaps fill at open; intrabar stop timing is unknown and counted at bar end. No targets or limit fills.", "Fees, half-spread and adverse slippage are charged separately in integer paise; flat estimates, not actual broker taxes. No leverage. Drawdown and daily loss checks use minute-close marks and can understate intrabar losses; exits can occur one minute after a hold-time threshold. Simultaneous entries are allocated by symbol name.", "Participation uses prior-bar volume; first-opening benchmark assumes available liquidity without a prior session book. No partial fills or queue simulation.", "Fixed declared historical universe; membership, corporate-action adjustments and source authenticity are uploader assertions. Missing members/bars fail closed; delistings require a suitable dataset.", "Holdout starts with fresh cash and no tuning on that window. Repeated human tuning can still contaminate a holdout; use a new unseen period.", "Recorded AI uses only supplied timestamped decisions with declared training/feature cutoffs; provenance is unverified, not proof of historical model knowledge. Sparse decision archives treat unrecorded times as HOLD and do not establish a complete provider history. No provider is called.", "Weekday 09:15–15:30 IST sessions; no exchange holiday calendar. Research results do not establish live profitability."], source: dataset.source, universeAsOf: dataset.universeAsOf, synthetic: dataset.synthetic };
}
