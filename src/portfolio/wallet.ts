import type Database from "better-sqlite3";
import type { PaperOrder, PaperPosition, PaperSettings } from "./types.js";

/** All tables belong exclusively to the single virtual account. Money is integer paise. */
export class PaperWallet {
  constructor(readonly db: Database.Database, readonly settings: PaperSettings, now: number) {
    db.pragma("busy_timeout = 3000");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS paper_migrations (version INTEGER PRIMARY KEY);
    `);
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS paper_account (id INTEGER PRIMARY KEY CHECK(id=1), initial_paise INTEGER NOT NULL CHECK(initial_paise>0));
        CREATE TABLE IF NOT EXISTS paper_orders (
          id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
          symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('buy','sell')), qty INTEGER NOT NULL CHECK(qty>0),
          type TEXT NOT NULL CHECK(type IN ('market','limit')), limit_paise INTEGER, stop_paise INTEGER,
          status TEXT NOT NULL CHECK(status IN ('open','filled','cancelled','expired','rejected')),
          reserved_paise INTEGER NOT NULL DEFAULT 0 CHECK(reserved_paise>=0),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, fill_paise INTEGER, fee_paise INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS paper_orders_status ON paper_orders(status, symbol);
        CREATE TABLE IF NOT EXISTS paper_events (id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES paper_orders(id), ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS paper_fills (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(id), ts INTEGER NOT NULL, qty INTEGER NOT NULL, price_paise INTEGER NOT NULL, fee_paise INTEGER NOT NULL, quote_ts INTEGER NOT NULL, assumptions TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS paper_ledger (id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, order_id TEXT REFERENCES paper_orders(id), ts INTEGER NOT NULL, kind TEXT NOT NULL, cash_paise INTEGER NOT NULL, fee_paise INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS paper_positions (symbol TEXT PRIMARY KEY, qty INTEGER NOT NULL CHECK(qty>0), cost_paise INTEGER NOT NULL CHECK(cost_paise>0), entry_fee_paise INTEGER NOT NULL, stop_paise INTEGER, opened_at INTEGER NOT NULL, mark_paise INTEGER NOT NULL, mark_ts INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS paper_trades (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, qty INTEGER NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER NOT NULL, order_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(id), entry_paise INTEGER NOT NULL, exit_paise INTEGER NOT NULL, fee_paise INTEGER NOT NULL, pnl_paise INTEGER NOT NULL, reason TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS paper_days (date TEXT PRIMARY KEY, start_equity_paise INTEGER NOT NULL, halted INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO paper_migrations VALUES (1);
      `);
      const columns = db.prepare("PRAGMA table_info(paper_positions)").all() as { name: string }[];
      if (!columns.some(c => c.name === "entry_order_id")) db.exec("ALTER TABLE paper_positions ADD COLUMN entry_order_id TEXT REFERENCES paper_orders(id)");
      db.prepare("INSERT OR IGNORE INTO paper_migrations VALUES (2)").run();
      const result = db.prepare("INSERT OR IGNORE INTO paper_account VALUES (1, ?)").run(settings.initialCapital);
      if (result.changes) db.prepare("INSERT INTO paper_ledger(event_key,ts,kind,cash_paise) VALUES ('initial',?,'deposit',?)").run(now, settings.initialCapital);
    }).immediate();
  }

  orders(): PaperOrder[] { return this.db.prepare("SELECT * FROM paper_orders ORDER BY created_at, id").all() as PaperOrder[]; }
  positions(): PaperPosition[] { return this.db.prepare("SELECT * FROM paper_positions ORDER BY symbol").all() as PaperPosition[]; }
  cash(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cash_paise),0) AS cash FROM paper_ledger").get() as { cash: number };
    return row.cash;
  }
  reserved(): number { return this.orders().filter(o => o.status === "open").reduce((sum, o) => sum + o.reserved_paise, 0); }
  available(): number { return this.cash() - this.reserved(); }
  event(order: PaperOrder, ts: number, kind: string, detail = ""): void {
    this.db.prepare("INSERT INTO paper_events(order_id,ts,kind,detail) VALUES (?,?,?,?)").run(order.id, ts, kind, detail);
  }
}
