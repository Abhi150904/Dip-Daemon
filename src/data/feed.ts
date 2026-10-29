import { insertSnapshot } from "../db.js";
import { applyQuoteToBar, seedBars } from "./bars.js";
import type { Bar, Quote } from "../types.js";
import type { Broker } from "../broker.js";
import { INDEX_TOKEN } from "../symbols.js";
import { log } from "../ops/log.js";

export interface Feed {
  kind: "live" | "replay" | "candles";
  tick(): Promise<Map<string, Quote>>;
}

export class LiveFeed implements Feed {
  kind = "live" as const;
  quotes = new Map<string, Quote>();
  private failures = 0;
  private retryAt = 0;
  lastQuoteSuccess: number | null = null;
  status() { return { failures: this.failures, retryAt: this.retryAt, lastQuoteSuccess: this.lastQuoteSuccess }; }

  constructor(
    private client: Broker,
    private universeTokens: () => { token: string; segment: string; symbol: string }[],
    private activeTokens: () => { token: string; segment: string; symbol: string }[],
    /** Replay already has the bars; polling quotes must not overwrite them. */
    private writeBars = true,
    private writeSnapshots = true,
  ) {}

  async tick(): Promise<Map<string, Quote>> {
    if (Date.now() < this.retryAt) return this.quotes;
    const uni = this.universeTokens();
    const active = this.activeTokens();
    const seen = new Set<string>();
    const req: { token: string; segment: string }[] = [];
    for (const t of [...active, ...uni]) {
      if (seen.has(t.token)) continue;
      seen.add(t.token);
      req.push({ token: t.token, segment: t.segment });
    }
    let qs: Quote[];
    try {
      qs = await this.client.quotes(req);
      if (req.length && !qs.length) throw new Error("Quote response was empty");
      this.failures = 0; this.retryAt = 0; this.lastQuoteSuccess = Date.now();
    } catch (error) {
      this.failures++; this.retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(6, this.failures));
      log("warn", "market_data_retry", { retryAt: this.retryAt, failures: this.failures, error });
      throw error;
    }
    const byToken = new Map(uni.concat(active).map((t) => [t.token, t.symbol]));
    for (const q of qs) {
      const symbol = q.symbol || byToken.get(q.token) || q.token;
      q.symbol = symbol;
      this.quotes.set(symbol, q);
      if (this.writeSnapshots) {
        insertSnapshot({
          ts: q.ts,
          symbol,
          token: q.token,
          segment: q.segment,
          ltp: q.ltp,
          bid: q.bid,
          ask: q.ask,
          volume: q.volume,
          tbq: q.tbq,
          tsq: q.tsq,
          bidQty: q.bids.reduce((s, l) => s + l.qty, 0),
          askQty: q.asks.reduce((s, l) => s + l.qty, 0),
          json: JSON.stringify({ bids: q.bids, asks: q.asks }),
        });
      }
      if (this.writeBars) applyQuoteToBar(q);
    }
    return this.quotes;
  }
}

export class ReplayFeed implements Feed {
  kind = "replay" as const;
  private i = 0;
  quotes = new Map<string, Quote>();

  constructor(private rows: Quote[]) {}

  async tick(): Promise<Map<string, Quote>> {
    if (this.i >= this.rows.length) return this.quotes;
    const q = this.rows[this.i++];
    this.quotes.set(q.symbol, q);
    insertSnapshot({
      ts: q.ts,
      symbol: q.symbol,
      token: q.token,
      segment: q.segment,
      ltp: q.ltp,
      bid: q.bid,
      ask: q.ask,
      volume: q.volume,
      tbq: q.tbq,
      tsq: q.tsq,
      bidQty: 0,
      askQty: 0,
      json: "{}",
    });
    applyQuoteToBar(q);
    return this.quotes;
  }
}

export class CandlesFeed implements Feed {
  kind = "candles" as const;
  quotes = new Map<string, Quote>();

  constructor(private series: Map<string, Bar[]>, private idx = 0) {
    for (const [symbol, bars] of series) seedBars(symbol, bars);
  }

  maxLen(): number {
    let m = 0;
    for (const bars of this.series.values()) m = Math.max(m, bars.length);
    return m;
  }

  at(i: number): Map<string, Quote> {
    this.idx = i;
    this.quotes.clear();
    for (const [symbol, bars] of this.series) {
      const b = bars[i];
      if (!b) continue;
      const q: Quote = {
        symbol,
        token: symbol === "Nifty 50" ? INDEX_TOKEN : symbol,
        segment: "nse_cm",
        ts: b.ts,
        ltp: b.close,
        ltq: 0,
        volume: b.volume,
        bid: b.close,
        ask: b.close,
        tbq: 0,
        tsq: 0,
        bids: [],
        asks: [],
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        tickSize: 0.05,
      };
      this.quotes.set(symbol, q);
    }
    return this.quotes;
  }

  async tick(): Promise<Map<string, Quote>> {
    const q = this.at(this.idx);
    this.idx++;
    return q;
  }
}
