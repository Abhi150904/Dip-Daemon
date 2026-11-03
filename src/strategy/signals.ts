import { PaperError } from "../portfolio/types.js";
import type { Bar, Quote } from "../types.js";
import { istDateStr, minutesOfDay } from "../time.js";

export interface AutomationSettings {
  mode: "off" | "approval" | "automatic";
  strategy: "vwap_momentum" | "jev";
  scanIntervalS: number;
  cooldownS: number;
  signalTtlS: number;
  modelTimeoutMs: number;
  minScore: number;
  momentumBps: number;
  minVolumeRatio: number;
  stopAtrMult: number;
  maxStopBps: number;
  maxPriceDriftBps: number;
  maxHoldMinutes: number;
}
export const automationDefaults: AutomationSettings = {
  mode: "off", strategy: "vwap_momentum", scanIntervalS: 30, cooldownS: 300, signalTtlS: 60,
  modelTimeoutMs: 10000, minScore: 0.6, momentumBps: 5, minVolumeRatio: 1.2,
  stopAtrMult: 1.5, maxStopBps: 100, maxPriceDriftBps: 50, maxHoldMinutes: 30,
};
export function automationSettings(raw: unknown, base = automationDefaults): AutomationSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PaperError("Expected automation settings", 400);
  const values = { ...base };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "mode") {
      if (value !== "off" && value !== "approval" && value !== "automatic") throw new PaperError("Invalid automation mode", 400);
      values.mode = value;
    } else if (key === "strategy") {
      if (value !== "vwap_momentum" && value !== "jev") throw new PaperError("Invalid paper strategy", 400);
      values.strategy = value;
    } else {
      const ranges = {
        scanIntervalS: [5, 3600], cooldownS: [0, 86400], signalTtlS: [5, 300], modelTimeoutMs: [10, 60000],
        minScore: [0, 1], momentumBps: [1, 100], minVolumeRatio: [0.1, 10], stopAtrMult: [0.1, 10],
        maxStopBps: [10, 500], maxPriceDriftBps: [1, 500], maxHoldMinutes: [1, 360],
      };
      if (!Object.hasOwn(ranges, key)) throw new PaperError(`Unknown automation setting ${key}`, 400);
      const name = key as keyof typeof ranges;
      const [min, max] = ranges[name];
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new PaperError(`Invalid ${name}`, 400);
      values[name] = value;
    }
  }
  return values;
}

interface SignalBase {
  symbol: string;
  strategy: AutomationSettings["strategy"];
  strategyVersion: string;
  modelVersion: string;
  score: number;
  reason: string;
  quoteTs: number;
  barTs: number;
  generatedAt: number;
  expiresAt: number;
}
export type Signal = SignalBase & (
  | { action: "BUY"; entryPrice: number; stopLoss: number }
  | { action: "SELL"; entryPrice: number }
  | { action: "HOLD" }
);
export function validSignal(value: Signal): boolean {
  return /^[A-Z0-9&-]{1,30}$/.test(value.symbol) && Number.isFinite(value.score) && value.score >= 0 && value.score <= 1 &&
    value.reason.length > 0 && value.strategyVersion.length > 0 && value.modelVersion.length > 0 &&
    [value.quoteTs, value.barTs, value.generatedAt, value.expiresAt].every(Number.isSafeInteger) &&
    value.quoteTs <= value.generatedAt && value.barTs + 60000 <= value.generatedAt && value.expiresAt > value.generatedAt &&
    (value.action === "HOLD" || (Number.isFinite(value.entryPrice) && value.entryPrice > 0 &&
      (value.action === "SELL" || (Number.isFinite(value.stopLoss) && value.stopLoss > 0 && value.stopLoss < value.entryPrice))));
}

export function completedBars(bars: readonly Bar[], symbol: string, now: number): Bar[] {
  const date = istDateStr(now);
  const eligible = bars.filter(b => b.ts + 60000 <= now && istDateStr(b.ts) === date && minutesOfDay(b.ts) >= 555);
  for (let i = 0; i < eligible.length; i++) {
    const b = eligible[i];
    if (b.symbol !== symbol || !Number.isSafeInteger(b.ts) || (i && b.ts - eligible[i - 1].ts !== 60000) ||
      ![b.open, b.high, b.low, b.close].every(n => Number.isFinite(n) && n > 0) ||
      !Number.isFinite(b.volume) || b.volume <= 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) {
      throw new PaperError("Invalid or discontinuous completed candle data");
    }
  }
  if (eligible.length < 20 || now - eligible[eligible.length - 1].ts > 120000) throw new PaperError("Need 20 recent completed one-minute bars");
  return eligible;
}

export function baselineSignal(quote: Quote, bars: readonly Bar[], settings: AutomationSettings, now: number, held: boolean): Signal {
  const history = completedBars(bars, quote.symbol, now);
  const last = history[history.length - 1];
  const volume = history.reduce((s, b) => s + b.volume, 0);
  const vwap = history.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0) / volume;
  const momentum = (last.close / history[history.length - 4].close - 1) * 10000;
  const priorVolume = history.slice(-11, -1).reduce((s, b) => s + b.volume, 0) / 10;
  const ratio = last.volume / priorVolume;
  const atr = history.slice(-14).reduce((s, b, i) => {
    const previous = history[history.length - 15 + i].close;
    return s + Math.max(b.high - b.low, Math.abs(b.high - previous), Math.abs(b.low - previous));
  }, 0) / 14;
  const entryPrice = quote.ask || quote.ltp;
  const base: SignalBase = { symbol: quote.symbol, strategy: "vwap_momentum", strategyVersion: "vwap-momentum-v1",
    modelVersion: "deterministic-v1", score: 0, reason: "No continuation setup", quoteTs: quote.ts, barTs: last.ts,
    generatedAt: now, expiresAt: now + settings.signalTtlS * 1000 };
  if (held) {
    if (last.close < vwap || momentum <= -settings.momentumBps) return { ...base, score: 1, action: "SELL", entryPrice: quote.bid || quote.ltp, reason: "Completed-bar VWAP breakdown or negative three-bar momentum" };
    return { ...base, action: "HOLD", reason: "Position continuation remains intact" };
  }
  const distance = Math.max(atr * settings.stopAtrMult, entryPrice * 0.001);
  if (last.close <= vwap || momentum < settings.momentumBps || ratio < settings.minVolumeRatio ||
    (last.close / vwap - 1) * 10000 > 200 || distance / entryPrice * 10000 > settings.maxStopBps) return { ...base, action: "HOLD" };
  return { ...base, action: "BUY", entryPrice, stopLoss: Math.floor((entryPrice - distance) * 100) / 100,
    score: Math.min(1, 0.6 + Math.min(momentum / settings.momentumBps, 3) * 0.05 + Math.min(ratio, 3) * 0.05),
    reason: `Above completed-session VWAP; three-bar momentum ${momentum.toFixed(1)} bps; volume ratio ${ratio.toFixed(2)}` };
}
