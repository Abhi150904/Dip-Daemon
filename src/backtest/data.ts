import { createHash } from "node:crypto";
import { PaperError } from "../portfolio/types.js";
import { isWeekday, istDateStr, minutesOfDay } from "../time.js";
import type { Bar } from "../types.js";
export function object(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new PaperError("Expected an object", 400);
    return Object.fromEntries(Object.entries(raw));
}
export function text(raw: unknown, name: string, max = 200): string {
    if (typeof raw !== "string" || !raw.trim() || raw.length > max)
        throw new PaperError(`Invalid ${name}`, 400);
    return raw.trim();
}
export function numeric(raw: unknown, name: string, min: number, max: number): number {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max)
        throw new PaperError(`Invalid ${name}`, 400);
    return raw;
}
export function date(raw: unknown): string {
    const value = text(raw, "ISO date", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
        throw new PaperError("Invalid calendar date", 400);
    return value;
}
export function symbol(raw: unknown): string {
    const value = text(raw, "symbol", 30);
    if (!/^[A-Z0-9&-]+$/.test(value))
        throw new PaperError("Invalid symbol", 400);
    return value;
}
export interface RecordedDecision {
    symbol: string;
    ts: number;
    featureBarTs: number;
    trainingEnd: number;
    action: "BUY" | "SELL" | "HOLD";
    stopLoss: number | null;
    modelVersion: string;
    reason: string;
}
export interface Dataset {
    name: string;
    source: string;
    universeAsOf: string;
    synthetic: boolean;
    bars: Bar[];
    decisions: RecordedDecision[];
    dates: string[];
    symbols: string[];
    hash: string;
}
export function parseDataset(raw: unknown): Dataset {
    const input = object(raw);
    const name = text(input.name, "dataset name", 80), source = text(input.source, "data source");
    const universeAsOf = date(input.universeAsOf);
    if (typeof input.synthetic !== "boolean")
        throw new PaperError("Declare synthetic true or false", 400);
    if (!Array.isArray(input.bars) || !input.bars.length || input.bars.length > 30000)
        throw new PaperError("Provide 1–30000 one-minute bars", 400);
    const bars = input.bars.map(rawBar => {
        const b = object(rawBar);
        const ts = numeric(b.ts, "bar timestamp", 0, 9e12);
        const result = { symbol: symbol(b.symbol), ts, open: numeric(b.open, "open", .01, 1e6), high: numeric(b.high, "high", .01, 1e6), low: numeric(b.low, "low", .01, 1e6), close: numeric(b.close, "close", .01, 1e6), volume: numeric(b.volume, "volume", 1, 1e12) };
        if (!Number.isSafeInteger(ts) || ts % 60000 || !isWeekday(ts) || minutesOfDay(ts) < 555 || minutesOfDay(ts) > 929 || result.high < Math.max(result.open, result.close) || result.low > Math.min(result.open, result.close) || result.high < result.low)
            throw new PaperError("Invalid NSE session OHLCV bar", 400);
        return result;
    }).sort((a, b) => a.ts - b.ts || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    if (!Array.isArray(input.dates) || !input.dates.length || !Array.isArray(input.symbols) || !input.symbols.length)
        throw new PaperError("Declare dates and symbols arrays; missing members/sessions cannot be inferred away", 400);
    const dates = input.dates.map(date).sort(), symbols = input.symbols.map(symbol).sort();
    if (new Set(dates).size !== dates.length || new Set(symbols).size !== symbols.length)
        throw new PaperError("Duplicate declared date or symbol", 400);
    if (bars.some(b => !symbols.includes(b.symbol) || !dates.includes(istDateStr(b.ts))))
        throw new PaperError("Bars outside the declared universe/sessions", 400);
    if (symbols.length > 20 || dates.length > 30)
        throw new PaperError("Maximum 20 symbols and 30 sessions per dataset", 400);
    // Every member must have the same complete session. Missing/delisted members cannot silently disappear.
    const groups = new Map<string, Bar[]>();
    for (const b of bars) {
        const key = `${istDateStr(b.ts)}:${b.symbol}`;
        const list = groups.get(key) ?? [];
        list.push(b);
        groups.set(key, list);
    }
    for (const day of dates)
        for (const name of symbols) {
            const list = groups.get(`${day}:${name}`);
            if (!list || list.length !== 375 || minutesOfDay(list[0].ts) !== 555 || list.some((b, i) => i > 0 && b.ts - list[i - 1].ts !== 60000))
                throw new PaperError(`Need 375 unique contiguous bars for ${name} on ${day}; missing, duplicate or partial session`, 400);
        }
    if (universeAsOf > dates[0])
        throw new PaperError("Universe date must be on/before the first session; declare historical membership", 400);
    if (input.decisions !== undefined && !Array.isArray(input.decisions))
        throw new PaperError("decisions must be an array", 400);
    const barKeys = new Set(bars.map(b => `${b.symbol}:${b.ts}`));
    const decisions: RecordedDecision[] = (input.decisions ?? []).map((rawDecision): RecordedDecision => {
        const d = object(rawDecision), action = d.action;
        if (action !== "BUY" && action !== "SELL" && action !== "HOLD")
            throw new PaperError("Invalid recorded AI action", 400);
        const sym = symbol(d.symbol), ts = numeric(d.ts, "decision timestamp", 0, 9e12), featureBarTs = numeric(d.featureBarTs, "feature cutoff", 0, 9e12), trainingEnd = numeric(d.trainingEnd, "model training cutoff", 0, 9e12);
        if (![ts, featureBarTs, trainingEnd].every(Number.isSafeInteger) || featureBarTs + 60000 > ts || trainingEnd >= bars[0].ts || !barKeys.has(`${sym}:${featureBarTs}`) || istDateStr(ts) !== istDateStr(featureBarTs))
            throw new PaperError("Recorded decisions require completed source bars and a training cutoff before the dataset", 400);
        return { symbol: sym, ts, featureBarTs, trainingEnd, action, stopLoss: action === "BUY" ? numeric(d.stopLoss, "AI stop-loss", .01, 1e6) : null, modelVersion: text(d.modelVersion, "model version"), reason: text(d.reason, "decision reason", 1000) };
    }).sort((a, b) => a.ts - b.ts || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    const decisionKeys = new Set<string>();
    for (const d of decisions) {
        const key = `${d.symbol}:${d.ts}`;
        if (decisionKeys.has(key))
            throw new PaperError("Duplicate recorded AI decision", 400);
        decisionKeys.add(key);
    }
    if (decisions.length > 30000)
        throw new PaperError("Too many decisions", 400);
    const content = { name, source, universeAsOf, synthetic: input.synthetic, bars, decisions };
    return { ...content, dates, symbols, hash: createHash("sha256").update(JSON.stringify(content)).digest("hex") };
}
export function syntheticDataset(): Dataset {
    const bars: Bar[] = [];
    for (const [dayIndex, day] of ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"].entries()) {
        for (const [symIndex, sym] of ["INFY", "TCS"].entries())
            for (let minute = 0; minute < 375; minute++) {
                const base = 100 + symIndex * 20 + dayIndex * 2;
                const open = Math.round((base + minute * .006 + Math.sin(minute / 12) * .3) * 100) / 100;
                const close = Math.round((open + .02 * Math.cos(minute / 5)) * 100) / 100;
                bars.push({ symbol: sym, ts: Date.parse(`${day}T03:45:00Z`) + minute * 60000, open, high: Math.max(open, close) + .1, low: Math.min(open, close) - .1, close, volume: minute % 15 === 14 ? 20000 : 10000 });
            }
    }
    return parseDataset({ name: "Synthetic evaluation fixture", source: "deterministic-fixture-v1; not historical NSE prices", universeAsOf: "2026-10-19", synthetic: true, dates: ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"], symbols: ["INFY", "TCS"], bars });
}
