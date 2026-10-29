import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { clock, isWeekday, istDateStr, minutesOfDay } from "../time.js";
import type { Quote } from "../types.js";
import { PaperWallet } from "../portfolio/wallet.js";
import { PaperError, paise, parsePaperRequest, type PaperOrder, type PaperSettings } from "../portfolio/types.js";
import type { PlaceIntent } from "./types.js";

/** Durable paper execution owns its accounting; it never calls Engine.handleFill or a broker. */
export class PaperExecutor {
  readonly name = "paper";
  readonly wallet: PaperWallet;
  constructor(db: Database.Database, readonly settings: PaperSettings,
    private readonly quotes: () => ReadonlyMap<string, Quote>,
    private readonly killed: () => boolean = () => false) {
    this.wallet = new PaperWallet(db, settings, clock.now());
  }
  private get db() { return this.wallet.db; }
  private inSession(): boolean { return isWeekday() && minutesOfDay() >= 555 && minutesOfDay() < 930; }
  private fee(notional: number): number { return Math.ceil(notional * this.settings.feeBps / 10000); }
  private notional(price: number, qty: number): number {
    const value = price * qty;
    if (!Number.isSafeInteger(value)) throw new PaperError("Order value exceeds supported precision");
    return value;
  }
  private quote(symbol: string): Quote {
    const q = this.quotes().get(symbol);
    if (!q || q.symbol !== symbol || q.segment !== "nse_cm" || !Number.isSafeInteger(q.ts) || q.ts > clock.now() || clock.now() - q.ts > this.settings.quoteMaxAgeMs) throw new PaperError("Missing, future, or stale market data");
    if (!(q.ltp > 0) || !Number.isFinite(q.ltp)) throw new PaperError("Invalid quote price");
    if (!Number.isFinite(q.tickSize) || q.tickSize <= 0) throw new PaperError("Invalid quote tick size");
    if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask) || q.bid < 0 || q.ask < 0 || ((q.bid > 0 || q.ask > 0) && !(q.bid > 0 && q.ask >= q.bid))) throw new PaperError("Invalid bid/ask quote");
    paise(q.ltp); paise(q.tickSize);
    if (q.bid > 0) { paise(q.bid); paise(q.ask); }
    return q;
  }
  private executionPrice(q: Quote, side: "buy" | "sell"): number {
    const sign = side === "buy" ? 1 : -1;
    const touch = q.bid > 0 ? (side === "buy" ? q.ask : q.bid) : q.ltp * (1 + sign * this.settings.fallbackSpreadBps / 20000);
    const tick = paise(q.tickSize || 0.05);
    const raw = touch * 100 * (1 + sign * this.settings.slippageBps / 10000);
    const rounded = (side === "buy" ? Math.ceil(raw / tick) : Math.floor(raw / tick)) * tick;
    if (!Number.isSafeInteger(rounded) || rounded <= 0) throw new PaperError("Invalid execution price");
    return rounded;
  }
  preview(symbol: string, side: "buy" | "sell") {
    const quote = this.quote(symbol);
    return { pricePaise: this.executionPrice(quote, side), quoteTs: quote.ts };
  }
  private mark(): void {
    for (const p of this.wallet.positions()) {
      try {
        const q = this.quote(p.symbol);
        this.db.prepare("UPDATE paper_positions SET mark_paise=?,mark_ts=? WHERE symbol=?").run(paise(q.bid || q.ltp), q.ts, p.symbol);
      } catch { /* Retain the last mark with its original timestamp; never make stale data fresh. */ }
    }
  }
  private valuation() {
    const positions = this.wallet.positions();
    const stale = positions.some(p => p.mark_ts > clock.now() || clock.now() - p.mark_ts > this.settings.quoteMaxAgeMs);
    const marketValue = positions.reduce((s, p) => s + p.qty * p.mark_paise, 0);
    return { positions, stale, marketValue, equity: this.wallet.cash() + marketValue };
  }
  private day() {
    const valuation = this.valuation();
    const date = istDateStr();
    // A persisted day baseline prevents restart or kill/resume from resetting a loss halt.
    if (!valuation.stale) this.db.prepare("INSERT OR IGNORE INTO paper_days(date,start_equity_paise) VALUES (?,?)").run(date, valuation.equity);
    const day = this.db.prepare("SELECT * FROM paper_days WHERE date=?").get(date) as { start_equity_paise: number; halted: number } | undefined;
    if (day && !valuation.stale && valuation.equity - day.start_equity_paise <= -this.settings.dailyLossLimit) {
      this.db.prepare("UPDATE paper_days SET halted=1 WHERE date=?").run(date);
      day.halted = 1;
    }
    return { day, valuation };
  }
  account() {
    return this.db.transaction(() => {
      this.mark();
      const { day, valuation } = this.day();
      const initial = this.db.prepare("SELECT initial_paise FROM paper_account WHERE id=1").get() as { initial_paise: number };
      const totals = this.db.prepare("SELECT COALESCE(SUM(fee_paise),0) AS fees FROM paper_ledger").get() as { fees: number };
      const realized = this.db.prepare("SELECT COALESCE(SUM(pnl_paise),0) AS pnl FROM paper_trades").get() as { pnl: number };
      return { currency: "INR", moneyUnit: "paise", mode: "paper", initialCapital: initial.initial_paise,
        availableCash: this.wallet.available(), reservedCash: this.wallet.reserved(), cash: this.wallet.cash(),
        investedCapital: valuation.positions.reduce((s, p) => s + p.cost_paise, 0),
        positionMarketValue: valuation.stale ? null : valuation.marketValue,
        lastKnownMarketValue: valuation.marketValue,
        equity: valuation.stale ? null : valuation.equity,
        realizedPnl: realized.pnl, unrealizedPnl: valuation.stale ? null : valuation.positions.reduce((s, p) => s + p.qty * p.mark_paise - p.cost_paise - p.entry_fee_paise, 0),
        fees: totals.fees, stalePrices: valuation.stale,
        dailyPnl: !day || valuation.stale ? null : valuation.equity - day.start_equity_paise,
        halted: !!day?.halted, killed: this.killed(), settings: this.settings, feesAreEstimates: true };
    }).immediate();
  }
  orders() { return this.wallet.orders(); }
  positions() {
    this.account();
    return this.wallet.positions().map(p => {
      const reservedShares = this.orders().filter(o => o.status === "open" && o.side === "sell" && o.symbol === p.symbol).reduce((s, o) => s + o.qty, 0);
      const fresh = p.mark_ts <= clock.now() && clock.now() - p.mark_ts <= this.settings.quoteMaxAgeMs;
      return { ...p, averageEntryPaise: Math.round(p.cost_paise / p.qty), reservedShares, availableShares: p.qty - reservedShares,
        marketValuePaise: fresh ? p.qty * p.mark_paise : null,
        unrealizedPnlPaise: fresh ? p.qty * p.mark_paise - p.cost_paise - p.entry_fee_paise : null };
    });
  }
  trades() { return this.db.prepare("SELECT * FROM paper_trades ORDER BY closed_at,id").all(); }
  events() { return this.db.prepare("SELECT * FROM paper_events ORDER BY id DESC LIMIT 200").all(); }
  ledger() { return this.db.prepare("SELECT * FROM paper_ledger ORDER BY id").all(); }
  order(id: string): PaperOrder {
    const row = this.db.prepare("SELECT * FROM paper_orders WHERE id=?").get(id) as PaperOrder | undefined;
    if (!row) throw new PaperError("Paper order not found", 404);
    return row;
  }

  place(intent: PlaceIntent & { idempotencyKey: string }, reason = "manual"): PaperOrder {
    if (intent.leg !== "equity" || intent.segment !== "nse_cm" || intent.kind === "stop" ||
      (intent.kind === "entry" ? intent.side !== "buy" : intent.side !== "sell")) {
      throw new PaperError("Paper intents support long-only cash entries/exits; attach stop to the entry");
    }
    return this.submit({ idempotencyKey: intent.idempotencyKey, symbol: intent.symbol, side: intent.side,
      qty: intent.qty, type: intent.tif === "MKT" ? "market" : "limit",
      ...(intent.tif === "MKT" ? {} : { limitPrice: intent.price }),
      ...(intent.kind === "entry" && intent.stop !== undefined ? { stopLoss: intent.stop } : {}) }, reason);
  }

  submit(raw: unknown, reason = "manual"): PaperOrder {
    const request = parsePaperRequest(raw);
    const payload = JSON.stringify(request);
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM paper_orders WHERE request_key=?").get(request.idempotencyKey) as PaperOrder | undefined;
      if (prior) {
        if (prior.payload !== payload) throw new PaperError("Idempotency key belongs to a different request", 409);
        return prior;
      }
      const id = randomUUID();
      const now = clock.now();
      this.db.prepare(`INSERT INTO paper_orders(id,request_key,payload,symbol,side,qty,type,limit_paise,stop_paise,status,created_at,updated_at,reason)
        VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?)`).run(id, request.idempotencyKey, payload, request.symbol, request.side, request.qty, request.type,
          request.limitPrice === undefined ? null : paise(request.limitPrice), request.stopLoss === undefined ? null : paise(request.stopLoss), now, now, reason);
      const order = this.order(id);
      this.wallet.event(order, now, "submitted", reason);
      try {
        if (!this.inSession()) throw new PaperError("Outside weekday NSE cash session");
        if (istDateStr() < this.settings.feeEffectiveFrom) throw new PaperError("No fee assumptions effective for this date");
        const q = this.quote(order.symbol);
        this.mark();
        const { day, valuation } = this.day();
        const px = this.executionPrice(q, order.side);
        if (order.side === "buy") {
          if (this.killed() || day?.halted || !day || valuation.stale) throw new PaperError("Paper risk halt or unavailable account valuation");
          if (minutesOfDay() >= 910) throw new PaperError("No new entries after 15:10 IST");
          const buySymbols = new Set([...valuation.positions.map(p => p.symbol), ...this.orders().filter(o => o.status === "open" && o.side === "buy" && o.id !== id).map(o => o.symbol)]);
          if (buySymbols.has(order.symbol)) throw new PaperError("Increasing a position or duplicate pending buy is not supported");
          if (buySymbols.size >= this.settings.maxPositions) throw new PaperError("Paper position limit reached");
          const ceiling = order.limit_paise ?? px;
          const notional = this.notional(ceiling, order.qty);
          if (notional > this.settings.maxOrderValue) throw new PaperError("Paper maximum buy order value exceeded");
          if (order.stop_paise !== null && order.stop_paise >= Math.min(ceiling, px)) throw new PaperError("Stop loss must be below entry price");
          const reserve = notional + this.fee(notional);
          if (reserve > this.wallet.available()) throw new PaperError("Insufficient virtual cash");
          this.db.prepare("UPDATE paper_orders SET reserved_paise=? WHERE id=?").run(reserve, id);
          this.wallet.event(order, now, "reserved", String(reserve));
        } else {
          const position = valuation.positions.find(p => p.symbol === order.symbol);
          const reservedShares = this.orders().filter(o => o.status === "open" && o.side === "sell" && o.symbol === order.symbol && o.id !== id).reduce((s, o) => s + o.qty, 0);
          if (!position || request.qty > position.qty - reservedShares) throw new PaperError("Insufficient unreserved shares; short selling is disabled");
        }
        this.fill(this.order(id), q, true);
      } catch (error) {
        if (!(error instanceof PaperError)) throw error;
        this.db.prepare("UPDATE paper_orders SET status='rejected',reserved_paise=0,reason=?,updated_at=? WHERE id=?").run(error.message, now, id);
        this.wallet.event(order, now, "rejected", error.message);
      }
      return this.order(id);
    }).immediate();
  }

  cancel(id: string): PaperOrder {
    return this.db.transaction(() => {
      const o = this.order(id);
      if (o.status === "cancelled") return o;
      if (o.status !== "open") throw new PaperError("Only open orders can be cancelled", 409);
      this.finish(o, "cancelled", "manual");
      return this.order(id);
    }).immediate();
  }
  modify(id: string, raw: unknown): PaperOrder {
    if (!raw || typeof raw !== "object" || !("limitPrice" in raw) || typeof raw.limitPrice !== "number" || Object.keys(raw).some(k => k !== "limitPrice")) throw new PaperError("Modification accepts limitPrice only", 400);
    const price = paise(raw.limitPrice);
    return this.db.transaction(() => {
      const o = this.order(id);
      if (o.status !== "open" || o.type !== "limit") throw new PaperError("Only open limit orders can be modified", 409);
      if (!this.inSession() || istDateStr(o.created_at) !== istDateStr()) throw new PaperError("Order session has ended");
      if (o.side === "buy") {
        this.mark();
        const { day, valuation } = this.day();
        if (this.killed() || day?.halted || !day || valuation.stale) throw new PaperError("Paper risk halt");
        const notional = this.notional(price, o.qty);
        const reserve = notional + this.fee(notional);
        if (notional > this.settings.maxOrderValue || reserve > this.wallet.available() + o.reserved_paise) throw new PaperError("Modified order exceeds cash or value limit");
        if (o.stop_paise !== null && o.stop_paise >= price) throw new PaperError("Stop must be below entry");
        this.db.prepare("UPDATE paper_orders SET reserved_paise=? WHERE id=?").run(reserve, id);
      }
      this.db.prepare("UPDATE paper_orders SET limit_paise=?,updated_at=? WHERE id=?").run(price, clock.now(), id);
      this.wallet.event(o, clock.now(), "modified", String(price));
      return this.order(id);
    }).immediate();
  }
  private finish(o: PaperOrder, status: "cancelled" | "expired" | "rejected", reason: string): void {
    this.db.prepare("UPDATE paper_orders SET status=?,reserved_paise=0,updated_at=?,reason=? WHERE id=? AND status='open'").run(status, clock.now(), reason, o.id);
    this.wallet.event(o, clock.now(), status, reason);
  }

  private fill(o: PaperOrder, q: Quote, accepting = false): void {
    if (o.status !== "open" || (!accepting && q.ts < o.updated_at)) return;
    const price = this.executionPrice(q, o.side);
    if (o.limit_paise !== null && (o.side === "buy" ? price > o.limit_paise : price < o.limit_paise)) return;
    if (o.side === "buy" && o.stop_paise !== null && price <= o.stop_paise) { this.finish(o, "rejected", "Price moved below entry stop"); return; }
    const value = this.notional(price, o.qty);
    const fee = this.fee(value);
    if (o.side === "buy" && (value + fee > o.reserved_paise || value > this.settings.maxOrderValue)) { this.finish(o, "rejected", "Fill exceeds reserved funds"); return; }
    this.db.prepare("INSERT INTO paper_fills VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), o.id, clock.now(), o.qty, price, fee, q.ts,
      JSON.stringify({ version: "research-flat-v1", ...this.settings, source: q.bid > 0 ? "bid-ask" : "ltp-with-estimated-spread" }));
    if (o.side === "buy") {
      this.db.prepare("INSERT INTO paper_positions(symbol,qty,cost_paise,entry_fee_paise,stop_paise,opened_at,mark_paise,mark_ts,entry_order_id) VALUES (?,?,?,?,?,?,?,?,?)").run(o.symbol, o.qty, value, fee, o.stop_paise, clock.now(), paise(q.bid || q.ltp), q.ts, o.id);
    } else {
      const p = this.wallet.positions().find(p => p.symbol === o.symbol);
      if (!p || o.qty > p.qty) throw new Error("Paper position invariant failed");
      const cost = o.qty === p.qty ? p.cost_paise : Math.floor(p.cost_paise * o.qty / p.qty);
      const entryFee = o.qty === p.qty ? p.entry_fee_paise : Math.floor(p.entry_fee_paise * o.qty / p.qty);
      this.db.prepare("INSERT INTO paper_trades VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), o.symbol, o.qty, p.opened_at, clock.now(), o.id, cost, value, entryFee + fee, value - cost - entryFee - fee, o.reason);
      if (o.qty === p.qty) this.db.prepare("DELETE FROM paper_positions WHERE symbol=?").run(p.symbol);
      else this.db.prepare("UPDATE paper_positions SET qty=qty-?,cost_paise=cost_paise-?,entry_fee_paise=entry_fee_paise-? WHERE symbol=?").run(o.qty, cost, entryFee, p.symbol);
    }
    this.db.prepare("INSERT INTO paper_ledger(event_key,order_id,ts,kind,cash_paise,fee_paise) VALUES (?,?,?,?,?,?)").run(`fill:${o.id}`, o.id, clock.now(), o.side, (o.side === "buy" ? -value : value) - fee, fee);
    this.db.prepare("UPDATE paper_orders SET status='filled',reserved_paise=0,fill_paise=?,fee_paise=?,updated_at=? WHERE id=?").run(price, fee, clock.now(), o.id);
    this.wallet.event(o, clock.now(), "filled", JSON.stringify({ price, fee, quoteTs: q.ts }));
    if (this.wallet.available() < 0) throw new Error("Negative paper available cash invariant");
  }

  tick(): void {
    this.db.transaction(() => {
      this.mark();
      const { day, valuation } = this.day();
      const forced = this.killed() ? "kill" : day?.halted ? "daily_loss" : minutesOfDay() >= 910 ? "session_flatten" : "";
      for (const o of this.orders().filter(o => o.status === "open")) {
        if (istDateStr(o.created_at) !== istDateStr() || (isWeekday() && minutesOfDay() >= 930)) { this.finish(o, "expired", "DAY order expired"); continue; }
        if (forced && o.side === "buy") { this.finish(o, "cancelled", forced); continue; }
        if (!this.inSession() || istDateStr() < this.settings.feeEffectiveFrom) continue;
        let q: Quote;
        try { q = this.quote(o.symbol); } catch { continue; }
        this.fill(o, q);
      }
      if (!this.inSession()) return;
      for (const p of valuation.positions) {
        let q: Quote;
        try { q = this.quote(p.symbol); } catch { continue; }
        const stop = p.stop_paise !== null && paise(q.bid || q.ltp) <= p.stop_paise;
        if (!forced && !stop) continue;
        // Protective exits supersede manual resting exits and reserve the whole remaining position.
        for (const o of this.orders().filter(o => o.status === "open" && o.symbol === p.symbol && o.side === "sell")) this.finish(o, "cancelled", forced || "stop_loss");
        const current = this.wallet.positions().find(position => position.symbol === p.symbol);
        if (current) this.submit({ idempotencyKey: `exit:${p.symbol}:${p.opened_at}:${clock.now()}`, symbol: p.symbol, side: "sell", qty: current.qty, type: "market" }, forced || "stop_loss");
      }
    }).immediate();
  }
}
