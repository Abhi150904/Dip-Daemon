import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PaperExecutor } from "../executor/paper.js";
import { PaperError } from "../portfolio/types.js";
import type { Model } from "../model/index.js";
import { clock, isWeekday, minutesOfDay } from "../time.js";
import type { StrategySnapshot } from "../strategy/ai-paper.js";
import { automationSettings, automationDefaults, baselineSignal, validSignal, type AutomationSettings, type Signal } from "../strategy/signals.js";

interface SignalRow {
  id: string; run_id: string; signal_key: string; symbol: string; action: Signal["action"];
  strategy: AutomationSettings["strategy"]; payload: string; status: "observed" | "pending" | "ordered" | "rejected" | "expired";
  reason: string; order_id: string | null; revision: number; created_at: number;
}

export class PaperAutomation {
  private scanning = false;
  private lastScan = 0;
  private stopped = false;
  get idle() { return !this.scanning; }
  stop() { if (this.stopped) return; this.configure({ mode: "off" }); this.stopped = true; }
  constructor(readonly db: Database.Database, readonly paper: PaperExecutor | undefined,
    private readonly snapshot: () => StrategySnapshot, private readonly model: Model,
    settings: AutomationSettings = automationDefaults) {
    if (paper && paper.wallet.db !== db) throw new PaperError("Automation and paper accounting must share one SQLite transaction");
    db.exec(`
      CREATE TABLE IF NOT EXISTS paper_automation_config (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_strategy_runs (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, completed_at INTEGER, status TEXT NOT NULL, strategy TEXT NOT NULL, parameters TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS paper_signals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES paper_strategy_runs(id), signal_key TEXT NOT NULL UNIQUE, symbol TEXT NOT NULL, action TEXT NOT NULL, strategy TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, order_id TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS paper_signal_time ON paper_signals(created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS paper_signal_order ON paper_signals(order_id);
      CREATE TABLE IF NOT EXISTS paper_signal_events (id INTEGER PRIMARY KEY, signal_id TEXT NOT NULL REFERENCES paper_signals(id), ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_cooldowns (symbol TEXT PRIMARY KEY, until_ts INTEGER NOT NULL);
    `);
    // Restart never silently resumes an API-enabled policy. Explicit startup settings may opt in.
    this.configure(settings);
    db.prepare("UPDATE paper_strategy_runs SET status='interrupted',completed_at=?,reason='Process restarted' WHERE status='running'").run(clock.now());
  }
  config(): { revision: number; settings: AutomationSettings } {
    const row = this.db.prepare("SELECT revision,payload FROM paper_automation_config WHERE id=1").get() as { revision: number; payload: string };
    return { revision: row.revision, settings: automationSettings(JSON.parse(row.payload)) };
  }
  configure(raw: unknown) {
    if (this.stopped) throw new PaperError("Strategy service is stopping", 503);
    const existing = this.db.prepare("SELECT payload FROM paper_automation_config WHERE id=1").get() as { payload: string } | undefined;
    const settings = automationSettings(raw, existing ? automationSettings(JSON.parse(existing.payload)) : automationDefaults);
    if (!this.paper && settings.mode !== "off") throw new PaperError("Automation execution requires TRADING_MODE=paper", 409);
    return this.db.transaction(() => {
      this.db.prepare("INSERT INTO paper_automation_config VALUES (1,1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,payload=excluded.payload").run(JSON.stringify(settings));
      for (const signal of this.rows("WHERE status='pending'")) this.finish(signal, "expired", "Automation configuration changed or process restarted");
      if (settings.mode === "off" && this.paper) {
        for (const signal of this.rows("WHERE status='ordered' AND action='BUY'")) {
          if (signal.order_id && this.paper.order(signal.order_id).status === "open") this.paper.cancel(signal.order_id);
        }
      }
      return this.config();
    }).immediate();
  }
  private rows(where = ""): SignalRow[] {
    return this.db.prepare(`SELECT * FROM paper_signals ${where} ORDER BY created_at DESC,id DESC${where ? "" : " LIMIT 200"}`).all() as SignalRow[];
  }
  signals() {
    for (const row of this.rows("WHERE status='pending'")) {
      const signal = JSON.parse(row.payload) as Signal;
      if (clock.now() >= signal.expiresAt) this.finish(row, "expired", "Signal approval window elapsed");
    }
    return this.rows().map(row => ({ ...row, signal: JSON.parse(row.payload) as Signal }));
  }
  runs() { return this.db.prepare("SELECT * FROM paper_strategy_runs ORDER BY started_at DESC LIMIT 100").all(); }
  events() { return this.db.prepare("SELECT * FROM paper_signal_events ORDER BY id DESC LIMIT 200").all(); }
  status() { return { ...this.config(), scanning: this.scanning, lastScan: this.lastScan, paperEnabled: !!this.paper, executionMode: this.paper ? "paper" : "observe" }; }
  private event(row: SignalRow, kind: string, detail: string): void {
    this.db.prepare("INSERT INTO paper_signal_events(signal_id,ts,kind,detail) VALUES (?,?,?,?)").run(row.id, clock.now(), kind, detail);
  }
  private finish(row: SignalRow, status: SignalRow["status"], reason: string): void {
    this.db.prepare("UPDATE paper_signals SET status=?,reason=? WHERE id=?").run(status, reason, row.id);
    this.event(row, status, reason);
  }
  reject(id: string) {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.status !== "pending") throw new PaperError("Only pending signals can be rejected", 409);
      this.finish(row, "rejected", "Rejected by user");
      return this.get(id);
    }).immediate();
  }
  private get(id: string): SignalRow {
    const row = this.db.prepare("SELECT * FROM paper_signals WHERE id=?").get(id) as SignalRow | undefined;
    if (!row) throw new PaperError("Signal not found", 404);
    return row;
  }
  approve(id: string) {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.status === "ordered") return row;
      if (row.status !== "pending") throw new PaperError("Signal is not pending approval", 409);
      if (this.config().settings.mode !== "approval") throw new PaperError("Approval mode is not active", 409);
      return this.execute(row);
    }).immediate();
  }
  private execute(row: SignalRow): SignalRow {
    const { settings, revision } = this.config();
    const signal = JSON.parse(row.payload) as Signal;
    try {
      if (!validSignal(signal) || signal.action === "HOLD") throw new PaperError("Invalid actionable signal");
      if (!this.paper || settings.mode === "off" || row.revision !== revision) throw new PaperError("Execution policy no longer permits this signal");
      if (clock.now() >= signal.expiresAt || clock.now() < signal.generatedAt) throw new PaperError("Signal expired or clock regressed");
      if (signal.score < settings.minScore) throw new PaperError("Signal score below minimum");
      const side = signal.action === "BUY" ? "buy" : "sell";
      const preview = this.paper.preview(signal.symbol, side);
      if (Math.abs(preview.pricePaise / 100 / signal.entryPrice - 1) * 10000 > settings.maxPriceDriftBps) throw new PaperError("Price moved beyond signal tolerance; rescan");
      let qty: number;
      if (side === "buy") {
        if (signal.action !== "BUY" || (preview.pricePaise / 100 - signal.stopLoss) / (preview.pricePaise / 100) * 10000 > settings.maxStopBps) throw new PaperError("Current stop distance exceeds deterministic risk limit");
        const cooldown = this.db.prepare("SELECT until_ts FROM paper_cooldowns WHERE symbol=?").get(signal.symbol) as { until_ts: number } | undefined;
        const trade = this.paper.wallet.db.prepare("SELECT MAX(closed_at) AS closed FROM paper_trades WHERE symbol=?").get(signal.symbol) as { closed: number | null };
        if ((cooldown?.until_ts ?? 0) > clock.now() || (trade.closed !== null && trade.closed + settings.cooldownS * 1000 > clock.now())) throw new PaperError("Symbol is cooling down");
        const account = this.paper.account();
        if (account.halted || account.killed || account.stalePrices) throw new PaperError("Deterministic account risk halt");
        qty = Math.floor(Math.min(this.paper.settings.maxOrderValue, account.availableCash / (1 + this.paper.settings.feeBps / 10000)) / preview.pricePaise);
      } else {
        const position = this.paper.positions().find(p => p.symbol === signal.symbol);
        if (!position?.entry_order_id || !this.db.prepare("SELECT id FROM paper_signals WHERE order_id=? AND action='BUY' AND status='ordered'").get(position.entry_order_id)) throw new PaperError("No automation-owned position to exit");
        qty = position.availableShares;
      }
      if (qty < 1) throw new PaperError("Risk sizing produced no available whole shares");
      this.event(row, "risk_check", JSON.stringify({ qty, pricePaise: preview.pricePaise, revision, reason: signal.reason }));
      const order = this.paper.place({ symbol: signal.symbol, token: signal.symbol, tradingSymbol: signal.symbol, segment: "nse_cm", side, qty,
        price: preview.pricePaise / 100, kind: side === "buy" ? "entry" : "exit", tif: "MKT", tag: `signal:${row.id}`, decisionId: null, leg: "equity", tier: "B",
        stop: signal.action === "BUY" ? signal.stopLoss : undefined, idempotencyKey: `signal:${row.id}` }, `signal:${row.id}: ${signal.reason}`);
      this.db.prepare("UPDATE paper_signals SET order_id=? WHERE id=?").run(order.id, row.id);
      if (order.status === "rejected") this.finish(row, "rejected", order.reason);
      else {
        this.finish(row, "ordered", `Paper order ${order.status}`);
        this.db.prepare("INSERT INTO paper_cooldowns VALUES (?,?) ON CONFLICT(symbol) DO UPDATE SET until_ts=excluded.until_ts").run(signal.symbol, clock.now() + settings.cooldownS * 1000);
      }
    } catch (error) {
      if (!(error instanceof PaperError)) throw error;
      this.finish(row, "rejected", error.message);
    }
    return this.get(row.id);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const { settings } = this.config();
    if (settings.mode === "off" || this.scanning || clock.now() - this.lastScan < settings.scanIntervalS * 1000) return;
    if (!isWeekday() || minutesOfDay() < 555 || minutesOfDay() >= 910) return;
    await this.scan();
  }
  async scan() {
    if (this.stopped) throw new PaperError("Strategy service is stopping", 503);
    if (this.scanning) throw new PaperError("A strategy scan is already running", 409);
    const { settings, revision } = this.config();
    this.scanning = true;
    this.lastScan = clock.now();
    const run = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.db.prepare("INSERT INTO paper_strategy_runs(id,started_at,status,strategy,parameters) VALUES (?,?,'running',?,?)").run(run, this.lastScan, settings.strategy, JSON.stringify(settings));
      if (!isWeekday() || minutesOfDay() < 555 || minutesOfDay() >= 910) throw new PaperError("Outside strategy scan session");
      const snapshot = this.snapshot();
      if (settings.strategy === "jev" && (!snapshot.index || !Number.isFinite(snapshot.index.last) || snapshot.index.last <= 0 ||
        snapshot.indexTs === null || !Number.isSafeInteger(snapshot.indexTs) || snapshot.indexTs > this.lastScan || this.lastScan - snapshot.indexTs > (this.paper?.settings.quoteMaxAgeMs ?? 15000))) throw new PaperError("Missing or stale index data for AI regime evaluation");
      const positions = this.paper?.wallet.positions().filter(p => p.entry_order_id && this.db.prepare("SELECT id FROM paper_signals WHERE order_id=? AND action='BUY' AND status='ordered'").get(p.entry_order_id)) ?? [];
      if (!snapshot.quotes.length) throw new PaperError("No market snapshots available");
      for (const q of snapshot.quotes) {
        if (q.segment !== "nse_cm" || !Number.isSafeInteger(q.ts) || q.ts > this.lastScan || this.lastScan - q.ts > (this.paper?.settings.quoteMaxAgeMs ?? 15000) || !Number.isFinite(q.ltp) || q.ltp <= 0) throw new PaperError("Stale or invalid scan market data");
      }
      const skipped = new Map<string, string[]>();
      const skipSummary = () => [...skipped].map(([reason, symbols]) => `${reason} (${symbols.join(", ")})`).join(". ");
      const generate = async (): Promise<Signal[]> => {
        if (settings.strategy === "jev") {
          const { aiSignals } = await import("../strategy/ai-paper.js");
          return aiSignals(snapshot, positions, settings, this.model, this.lastScan);
        }
        const signals = snapshot.quotes.flatMap(q => {
          let signal: Signal;
          try {
            signal = baselineSignal(q, snapshot.bars.get(q.symbol) ?? [], settings, this.lastScan, positions.some(p => p.symbol === q.symbol));
          } catch (error) {
            if (!(error instanceof PaperError)) throw error;
            const symbols = skipped.get(error.message) ?? [];
            symbols.push(q.symbol);
            skipped.set(error.message, symbols);
            return [];
          }
          const p = positions.find(p => p.symbol === q.symbol);
          if (p && this.lastScan - p.opened_at >= settings.maxHoldMinutes * 60000) return [{ ...signal, action: "SELL" as const, entryPrice: q.bid || q.ltp, score: 1, reason: "Maximum strategy holding time reached" }];
          return [signal];
        });
        if (!signals.length) throw new PaperError(`No symbols had usable candles. ${skipSummary()}`);
        return signals;
      };
      const generated = await Promise.race([generate(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PaperError("Strategy/model scan timed out")), settings.modelTimeoutMs); })]);
      const fingerprint = createHash("sha256").update(JSON.stringify({ quotes: snapshot.quotes, bars: [...snapshot.bars], index: snapshot.index })).digest("hex");
      this.db.transaction(() => {
        if (this.config().revision !== revision) throw new PaperError("Policy changed while scan was running; results discarded");
        for (const signal of generated.sort((a, b) => (a.action === "SELL" ? -1 : 1) - (b.action === "SELL" ? -1 : 1) || b.score - a.score)) {
          if (!validSignal(signal)) throw new PaperError("Strategy returned an invalid signal");
          const key = createHash("sha256").update(JSON.stringify([signal.strategy, signal.strategyVersion, signal.modelVersion, signal.symbol, signal.action, signal.barTs])).digest("hex");
          const id = randomUUID();
          const status = !this.paper || settings.mode === "off" || signal.action === "HOLD" ? "observed" : signal.score < settings.minScore ? "rejected" : "pending";
          const insert = this.db.prepare("INSERT OR IGNORE INTO paper_signals VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(id, run, key, signal.symbol, signal.action, signal.strategy, JSON.stringify(signal), status,
            status === "rejected" ? "Signal score below minimum" : signal.reason, null, revision, clock.now());
          if (!insert.changes) continue;
          const row = this.get(id);
          this.event(row, "generated", JSON.stringify({ signal, revision, source: snapshot.source ?? "unspecified", snapshotHash: fingerprint }));
          if (status === "pending" && settings.mode === "automatic") this.execute(row);
        }
        this.db.prepare("UPDATE paper_strategy_runs SET status='completed',completed_at=?,reason=? WHERE id=?").run(clock.now(), skipped.size ? `Skipped symbols: ${skipSummary()}` : "", run);
      }).immediate();
    } catch (error) {
      const updated = this.db.prepare("UPDATE paper_strategy_runs SET status='failed',completed_at=?,reason=? WHERE id=?").run(clock.now(), error instanceof PaperError ? error.message : "Strategy failed; no new orders", run);
      if (!updated.changes) throw new PaperError("Could not persist strategy run; no orders submitted", 503);
    } finally {
      clearTimeout(timer);
      this.scanning = false;
    }
    return this.db.prepare("SELECT * FROM paper_strategy_runs WHERE id=?").get(run);
  }
}
