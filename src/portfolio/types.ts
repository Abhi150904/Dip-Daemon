export class PaperError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

export function paise(value: number): number {
  const result = Math.round(value * 100);
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(result) || result < 1 || result > 100_000_000_000) {
    throw new PaperError("Price or amount must be positive and within supported bounds");
  }
  return result;
}

export interface PaperSettings {
  initialCapital: number;
  maxOrderValue: number;
  maxPositions: number;
  dailyLossLimit: number;
  quoteMaxAgeMs: number;
  slippageBps: number;
  fallbackSpreadBps: number;
  feeBps: number;
  feeEffectiveFrom: string;
}

export function paperSettings(env: NodeJS.ProcessEnv): PaperSettings {
  const number = (name: string, fallback: number, allowZero = false) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value < (allowZero ? 0 : Number.EPSILON) || value > 1e9 || env[name]?.trim() === "") {
      throw new PaperError(`${name} must be a valid ${allowZero ? "nonnegative" : "positive"} number`);
    }
    return value;
  };
  const maxPositions = number("PAPER_MAX_POSITIONS", 3);
  if (!Number.isInteger(maxPositions) || maxPositions > 1000) throw new PaperError("PAPER_MAX_POSITIONS must be an integer <= 1000");
  const feeEffectiveFrom = env.PAPER_FEE_EFFECTIVE_FROM ?? "2026-01-01";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(feeEffectiveFrom) || new Date(`${feeEffectiveFrom}T00:00:00Z`).toISOString().slice(0, 10) !== feeEffectiveFrom) {
    throw new PaperError("PAPER_FEE_EFFECTIVE_FROM must be an ISO calendar date");
  }
  const settings = {
    initialCapital: paise(number("PAPER_INITIAL_CAPITAL", 10000)),
    maxOrderValue: paise(number("PAPER_MAX_ORDER_VALUE", 1000)), maxPositions,
    dailyLossLimit: paise(number("PAPER_DAILY_LOSS_LIMIT", 300)),
    quoteMaxAgeMs: number("PAPER_QUOTE_MAX_AGE_MS", 15000),
    slippageBps: number("PAPER_SLIPPAGE_BPS", 2, true),
    fallbackSpreadBps: number("PAPER_FALLBACK_SPREAD_BPS", 5, true),
    feeBps: number("PAPER_FEE_BPS", 5, true), feeEffectiveFrom,
  };
  if (Math.max(settings.slippageBps, settings.fallbackSpreadBps, settings.feeBps) > 100) throw new PaperError("Paper cost assumptions must be <= 100 bps");
  return settings;
}

export type PaperRequest = {
  idempotencyKey: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit";
  limitPrice?: number;
  stopLoss?: number;
};

export function parsePaperRequest(raw: unknown): PaperRequest {
  if (!raw || typeof raw !== "object") throw new PaperError("Expected an order object", 400);
  if (!("symbol" in raw) || typeof raw.symbol !== "string" || !/^[A-Z0-9&-]{1,30}$/.test(raw.symbol)) throw new PaperError("Invalid NSE symbol", 400);
  if (!("side" in raw) || (raw.side !== "buy" && raw.side !== "sell")) throw new PaperError("side must be buy or sell", 400);
  if (!("type" in raw) || (raw.type !== "market" && raw.type !== "limit")) throw new PaperError("type must be market or limit", 400);
  if (!("qty" in raw) || typeof raw.qty !== "number" || !Number.isSafeInteger(raw.qty) || raw.qty < 1 || raw.qty > 1_000_000) throw new PaperError("qty must be positive whole shares", 400);
  if (!("idempotencyKey" in raw) || typeof raw.idempotencyKey !== "string" || !/^[A-Za-z0-9:_-]{1,100}$/.test(raw.idempotencyKey)) throw new PaperError("A valid idempotencyKey is required", 400);
  let limitPrice: number | undefined;
  if (raw.type === "limit") {
    if (!("limitPrice" in raw) || typeof raw.limitPrice !== "number") throw new PaperError("limitPrice required", 400);
    limitPrice = paise(raw.limitPrice) / 100;
  } else if ("limitPrice" in raw) throw new PaperError("Market orders cannot have a limitPrice", 400);
  let stopLoss: number | undefined;
  if ("stopLoss" in raw) {
    if (raw.side !== "buy" || typeof raw.stopLoss !== "number") throw new PaperError("stopLoss is supported on buys only", 400);
    stopLoss = paise(raw.stopLoss) / 100;
  }
  return { idempotencyKey: raw.idempotencyKey, symbol: raw.symbol, side: raw.side, qty: raw.qty, type: raw.type, limitPrice, stopLoss };
}

export interface PaperOrder {
  id: string;
  request_key: string;
  payload: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit";
  limit_paise: number | null;
  stop_paise: number | null;
  status: "open" | "filled" | "cancelled" | "expired" | "rejected";
  reserved_paise: number;
  created_at: number;
  updated_at: number;
  fill_paise: number | null;
  fee_paise: number;
  reason: string;
}

export interface PaperPosition {
  entry_order_id: string | null;
  symbol: string;
  qty: number;
  cost_paise: number;
  entry_fee_paise: number;
  stop_paise: number | null;
  opened_at: number;
  mark_paise: number;
  mark_ts: number;
}
