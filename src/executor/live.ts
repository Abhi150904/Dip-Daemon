import { risk } from "../config.js";
import { db, insertEvent } from "../db.js";
import { alert } from "../alerts.js";
import { fillCost } from "../costs.js";
import type { Quote, WorkingOrder } from "../types.js";
import type { Executor, Fill, PlaceIntent } from "./types.js";
import { clock } from "../time.js";
import type { Broker, BrokerOrder, BrokerPosition } from "../broker.js";
import { randomBytes } from "node:crypto";

const tradingSymbols = new Map<number, string>();

export class LiveExecutor implements Executor {
  name = "live";
  orders = new Map<number, WorkingOrder>();
  onFill?: (fill: Fill) => void;
  lastBrokerPoll = 0;
  private polling = false;
  private readonly pendingCancels = new Set<number>();
  private ready = false;

  constructor(private client: Broker) {}

  async initialize(restorePositions?: (positions: BrokerPosition[], orders: BrokerOrder[]) => void): Promise<void> {
    this.ready = false;
    await this.restoreWorkingOrders();
    const brokerOrders = await this.client.orders();
    const local = new Map([...this.orders.values()].map(order => [order.brokerId, order]));
    for (const [id, order] of local) {
      const matches = brokerOrders.filter(remote => remote.orderId === id);
      if (matches.length !== 1 || matches[0].qty !== order.qty || !Number.isSafeInteger(matches[0].filledQty) || matches[0].filledQty < order.filledQty || matches[0].filledQty > order.qty ||
          matches[0].side !== order.side || matches[0].symbol !== (tradingSymbols.get(order.id) ?? this.client.getInstrument(order.symbol)?.tradingSymbol ?? order.symbol)) {
        throw new Error(`Broker order ${id} does not match saved order and fills. Submissions are locked.`);
      }
    }
    // Record offline executions before deciding whether broker positions can be managed.
    for (const [id, order] of local) {
      const remote = brokerOrders.find(candidate => candidate.orderId === id);
      if (remote && remote.filledQty > order.filledQty) await this.importTrades(order, remote.filledQty);
    }
    const terminal = new Set(["complete", "traded", "executed", "cancelled", "canceled", "rejected"]);
    if (brokerOrders.some(order => !terminal.has(order.status.trim().toLowerCase()) && !local.has(order.orderId))) {
      throw new Error("Untracked working order in the broker order book. Submissions are locked.");
    }
    const positions = (await this.client.positions()).filter(position => position.qty !== 0);
    if (restorePositions) restorePositions(positions, brokerOrders);
    else if (positions.length) {
      throw new Error("Open broker positions require reconciliation. Submissions are locked.");
    }
    this.ready = true;
  }

  /** Load persisted working orders before reconciling lost acknowledgements. */
  async restoreWorkingOrders(): Promise<void> {
    const rows = db.prepare<[], WorkingOrder>(`
      SELECT o.id, o.broker_id AS brokerId, o.symbol, o.token, o.segment, o.side, o.qty, o.price,
        o.trigger_price AS trigger, o.kind, o.status, o.tag, o.ts AS placedAt,
        o.last_modify_at AS lastModifyAt, o.decision_id AS decisionId, o.leg, o.tier, o.stop, o.target,
        o.stop_bps AS stopBps, 0 AS requotes,
        COALESCE((SELECT SUM(f.qty) FROM fills f WHERE f.order_id=o.id AND f.simulated=0), 0) AS filledQty
      FROM orders o WHERE o.status='open' AND o.broker_id IS NOT NULL
    `).all();
    for (const order of rows) {
      if (!Number.isSafeInteger(order.filledQty) || order.filledQty < 0 || order.filledQty > order.qty) {
        throw new Error(`Invalid recorded fill quantity for broker order ${order.brokerId}`);
      }
      if (!this.orders.has(order.id)) this.orders.set(order.id, order);
    }
    await this.recoverSubmissions();
  }

  async place(intent: PlaceIntent): Promise<WorkingOrder> {
    if (!this.ready) throw new Error("Broker startup reconciliation is incomplete. Submissions are locked.");
    const placedAt = clock.now();
    const nonce = randomBytes(7);
    const tag = intent.kind === "stop" ? `sl-${BigInt(`0x${nonce.toString("hex")}`)}` : `dd${nonce.toString("hex")}`;
    db.transaction(() => {
      if (db.prepare("SELECT 1 FROM broker_submission_intents LIMIT 1").get()) throw new Error("Unresolved broker submission. Reconcile before placing another order.");
      db.prepare("INSERT INTO broker_submission_intents VALUES (?, ?, ?)").run(tag, placedAt, JSON.stringify(intent));
    }).immediate();
    const orderType = intent.orderType ?? (intent.kind === "stop" ? "SL-L" : "L");
    const res = await this.client.place({
      segment: intent.segment,
      tradingSymbol: intent.tradingSymbol,
      token: intent.token,
      side: intent.side,
      qty: intent.qty,
      price: intent.price,
      orderType,
      trigger: intent.trigger,
      tag,
    });
    if (!res.orderId) {
      await alert("order_reject", `place failed ${intent.symbol} ${JSON.stringify(res.raw).slice(0, 300)}`);
      throw new Error("place failed");
    }
    return this.recordSubmission(intent, tag, placedAt, res.orderId);
  }

  /** Recover acknowledgements only. Fill accounting still runs through the broker poll. */
  async recoverSubmissions(): Promise<void> {
    const pending = db.prepare<[], { tag: string; placed_at: number; intent: string }>("SELECT tag, placed_at, intent FROM broker_submission_intents").all();
    if (!pending.length) return;
    const remote = await this.client.orders();
    for (const row of pending) {
      const intent: PlaceIntent = JSON.parse(row.intent);
      const matches = remote.filter(order => order.tag === row.tag);
      const order = matches[0];
      if (matches.length !== 1 || !order.orderId || order.symbol !== intent.tradingSymbol || order.side !== intent.side || order.qty !== intent.qty) {
        throw new Error(`Broker submission ${row.tag} is unresolved. Check the broker order book.`);
      }
      this.recordSubmission(intent, row.tag, row.placed_at, order.orderId);
    }
  }

  private recordSubmission(intent: PlaceIntent, tag: string, placedAt: number, brokerId: string): WorkingOrder {
    const info = db.transaction(() => {
      if (!db.prepare("DELETE FROM broker_submission_intents WHERE tag=?").run(tag).changes) throw new Error("Broker submission already reconciled");
      if (db.prepare("SELECT 1 FROM orders WHERE broker_id=?").get(brokerId)) throw new Error("Broker order already recorded");
      return db
      .prepare(
        `INSERT INTO orders (broker_id, ts, symbol, token, segment, side, qty, price, trigger_price, kind, status, tag, last_modify_at, decision_id, leg, tier, stop, target, stop_bps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        brokerId,
        placedAt,
        intent.symbol,
        intent.token,
        intent.segment,
        intent.side,
        intent.qty,
        intent.price,
        intent.trigger ?? null,
        intent.kind,
        intent.tag,
        clock.now(),
        intent.decisionId,
        intent.leg,
        intent.tier,
        intent.stop ?? null,
        intent.target ?? null,
        intent.stopBps ?? null,
      );
    }).immediate();
    const order: WorkingOrder = {
      id: Number(info.lastInsertRowid),
      brokerId,
      symbol: intent.symbol,
      token: intent.token,
      segment: intent.segment,
      side: intent.side,
      qty: intent.qty,
      price: intent.price,
      trigger: intent.trigger ?? null,
      kind: intent.kind,
      status: "open",
      tag: intent.tag,
      placedAt,
      lastModifyAt: clock.now(),
      filledQty: 0,
      requotes: 0,
      decisionId: intent.decisionId,
      leg: intent.leg,
      tier: intent.tier,
      stop: intent.stop ?? null,
      target: intent.target ?? null,
      stopBps: intent.stopBps ?? null,
      tif: intent.tif ?? "LMT",
    };
    tradingSymbols.set(order.id, intent.tradingSymbol);
    this.orders.set(order.id, order);
    insertEvent("order", `${intent.kind} ${intent.side} ${intent.qty} ${intent.symbol} @${intent.price}${intent.trigger ? ` trg ${intent.trigger}` : ""} #${brokerId}`);
    return order;
  }

  async modify(order: WorkingOrder, price: number, trigger?: number, qty?: number): Promise<void> {
    if (!order.brokerId) return;
    const newQty = qty ?? order.qty;
    await this.client.modify({
      orderId: order.brokerId,
      segment: order.segment,
      tradingSymbol: tradingSymbols.get(order.id) ?? this.client.getInstrument(order.symbol)?.tradingSymbol ?? order.symbol,
      token: order.token,
      side: order.side,
      qty: newQty,
      price,
      trigger,
      orderType: order.kind === "stop" ? "SL-L" : "L",
    });
    order.price = price;
    order.qty = newQty;
    if (trigger !== undefined) order.trigger = trigger;
    order.lastModifyAt = clock.now();
    order.requotes++;
    db.prepare("UPDATE orders SET price=?, trigger_price=?, qty=?, last_modify_at=? WHERE id=?").run(
      price,
      order.trigger,
      newQty,
      order.lastModifyAt,
      order.id,
    );
  }

  async cancel(order: WorkingOrder): Promise<void> {
    if (!order.brokerId || this.pendingCancels.has(order.id)) return;
    this.pendingCancels.add(order.id);
    try {
      await this.client.cancel(order.brokerId);
      insertEvent("order", `cancel requested ${order.kind} ${order.symbol} #${order.brokerId}`);
    } catch (e) {
      this.pendingCancels.delete(order.id);
      await alert("order_reject", `cancel failed ${order.symbol} ${e}`);
      throw e;
    }
  }

  async cancelAll(kind?: "entry" | "stop" | "exit"): Promise<void> {
    for (const o of [...this.orders.values()]) {
      if (kind && o.kind !== kind) continue;
      try {
        await this.cancel(o);
      } catch {
        /* alerted */
      }
    }
  }

  private async importTrades(order: WorkingOrder, filled: number): Promise<Fill[]> {
    if (!this.client.orderTrades || !order.brokerId) throw new Error("Broker trade history is unavailable");
    const trades = await this.client.orderTrades(order.brokerId);
    const unique = new Map(trades.map(trade => [trade.id, trade]));
    if (unique.size !== trades.length || trades.reduce((sum, trade) => sum + trade.quantity, 0) !== filled) {
      throw new Error(`Kite trade list disagrees with order ${order.brokerId}`);
    }
    const fills = db.transaction(() => {
      const recorded = db.prepare<[number, string], { qty: number; price: number }>(`SELECT f.qty, f.price FROM broker_trade_receipts r JOIN fills f ON f.id=r.fill_id WHERE r.order_id=? AND r.trade_id=?`);
      const missing = trades.filter(trade => {
        const prior = recorded.get(order.id, trade.id);
        if (prior && (prior.qty !== trade.quantity || prior.price !== trade.price)) throw new Error(`Kite trade ${trade.id} changed`);
        return !prior;
      });
      if (missing.reduce((sum, trade) => sum + trade.quantity, 0) !== filled - order.filledQty) throw new Error(`Saved fills for ${order.brokerId} need reconciliation`);
      return missing.map(trade => {
        const cost = fillCost(order.leg, order.side, trade.quantity, trade.price);
        const result = db.prepare("INSERT INTO fills (ts, order_id, symbol, side, qty, price, cost, simulated) VALUES (?,?,?,?,?,?,?,0)")
          .run(clock.now(), order.id, order.symbol, order.side, trade.quantity, trade.price, cost);
        db.prepare("INSERT INTO broker_trade_receipts VALUES (?,?,?)").run(order.id, trade.id, result.lastInsertRowid);
        return { order, qty: trade.quantity, price: trade.price, cost };
      });
    }).immediate();
    order.filledQty = filled;
    return fills;
  }

  async tick(_quotes: Map<string, Quote>): Promise<void> {
    if (!this.client.session || this.polling) return;
    if (clock.now() - this.lastBrokerPoll < 2000) return;
    this.polling = true;
    try {
      this.lastBrokerPoll = clock.now();
      if (!this.orders.size) return;
      const remote = await this.client.orders();
      for (const order of [...this.orders.values()]) {
        const r = remote.find((o) => o.orderId === order.brokerId);
        if (!r) continue;
        const st = r.status.trim().toLowerCase();
        const done = st === "complete" || st === "traded" || st === "executed";
        const filled = r.filledQty;
        if (!Number.isSafeInteger(filled) || filled < order.filledQty || filled > order.qty || (done && filled !== order.qty)) {
          throw new Error(`Broker fill quantity disagrees with order ${order.brokerId}`);
        }
        if (filled > order.filledQty && this.client.orderTrades && order.brokerId) {
          const fills = await this.importTrades(order, filled);
          for (const fill of fills) this.onFill?.(fill);
        } else if (filled > order.filledQty) {
          const delta = filled - order.filledQty;
          const px = r.price || order.price;
          const cost = fillCost(order.leg, order.side, delta, px);
          order.filledQty = filled;
          db.prepare("INSERT INTO fills (ts, order_id, symbol, side, qty, price, cost, simulated) VALUES (?,?,?,?,?,?,?,0)").run(
            clock.now(),
            order.id,
            order.symbol,
            order.side,
            delta,
            px,
            cost,
          );
          insertEvent("fill", `${order.kind} ${order.side} ${delta}/${order.qty} ${order.symbol} @${px}`);
          this.onFill?.({ order, qty: delta, price: px, cost });
        }
        if (done || order.filledQty >= order.qty) {
          this.pendingCancels.delete(order.id);
          order.status = "filled";
          db.prepare("UPDATE orders SET status='filled', price=? WHERE id=?").run(r.price || order.price, order.id);
          this.orders.delete(order.id);
          continue;
        }
        if (st === "cancelled" || st === "canceled" || st === "rejected") {
          this.pendingCancels.delete(order.id);
          if (st === "rejected") await alert("order_reject", `${order.symbol} ${r.status}`);
          order.status = st === "rejected" ? "rejected" : "cancelled";
          db.prepare("UPDATE orders SET status=? WHERE id=?").run(order.status, order.id);
          this.orders.delete(order.id);
          continue;
        }
        if (order.kind === "entry" && clock.now() - order.placedAt > risk.entryCancelMs) {
          try {
            await this.cancel(order);
          } catch {
            /* alerted; retry next poll */
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
