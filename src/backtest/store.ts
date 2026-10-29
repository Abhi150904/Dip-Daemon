import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { PaperError } from "../portfolio/types.js";
import { date, object, parseDataset, symbol, text, syntheticDataset } from "./data.js";
import { addDays, isWeekday } from "../time.js";
import { fingerprint, parseRun, type RunConfig } from "./engine.js";
import type { Dataset } from "./data.js";
let evaluating = false;
let evaluationWorker: Worker | undefined;
export async function stopEvaluations() { await evaluationWorker?.terminate(); }
async function runWorker(dataset: Dataset, config: RunConfig): Promise<unknown> {
    if (evaluating)
        throw new PaperError("An evaluation is already running; retry shortly", 409);
    evaluating = true;
    let worker: Worker | undefined;
    try {
        const active = new Worker(new URL("./worker.js", import.meta.url), { workerData: { dataset, config }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
        worker = active;
        evaluationWorker = active;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new PaperError("Evaluation exceeded its 15-second budget", 408)), 15000);
            active.once("message", result => { clearTimeout(timer); resolve(result); });
            active.once("error", error => { clearTimeout(timer); reject(error); });
            active.once("exit", () => { clearTimeout(timer); reject(new Error("Evaluation worker exited without a result")); });
        });
    }
    finally {
        await worker?.terminate();
        evaluating = false;
        evaluationWorker = undefined;
    }
}
export class Backtests {
    constructor(private readonly db: Database.Database) {
        db.exec(`CREATE TABLE IF NOT EXISTS backtest_datasets(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backtest_runs(id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, summary TEXT NOT NULL, result TEXT NOT NULL);`);
    }
    datasets() { return this.db.prepare<[
    ], {
        metadata: string;
    }>("SELECT metadata FROM backtest_datasets ORDER BY rowid DESC LIMIT 20").all().map(row => object(JSON.parse(row.metadata))); }
    import(raw: unknown) {
        const dataset = parseDataset(raw), id = dataset.hash;
        const metadata = { id, name: dataset.name, source: dataset.source, universeAsOf: dataset.universeAsOf, synthetic: dataset.synthetic, dates: dataset.dates, symbols: dataset.symbols, barCount: dataset.bars.length, aiDecisions: dataset.decisions.length };
        if (!this.db.prepare("SELECT 1 FROM backtest_datasets WHERE id=?").get(id) && this.datasets().length >= 20)
            throw new PaperError("Dataset storage limit reached (20)", 409);
        this.db.prepare("INSERT OR IGNORE INTO backtest_datasets VALUES (?,?,?)").run(id, JSON.stringify(metadata), JSON.stringify(dataset));
        return metadata;
    }
    demo() { return this.import(syntheticDataset()); }
    capture(raw: unknown) {
        const input = object(raw);
        const start = date(input.startDate), end = date(input.endDate);
        if (start > end || Date.parse(end) - Date.parse(start) > 45 * 86400000)
            throw new PaperError("Capture at most 45 calendar days, start ≤ end", 400);
        const symbols = text(input.symbols, "historical symbols", 620).split(",").map(s => symbol(s.trim()));
        if (symbols.length > 20)
            throw new PaperError("Capture at most 20 symbols", 400);
        const dates: string[] = [];
        for (let day = start; day <= end; day = addDays(day, 1))
            if (isWeekday(Date.parse(`${day}T03:45:00Z`)))
                dates.push(day);
        const bars = this.db.prepare(`SELECT symbol,ts,open,high,low,close,volume FROM bars_1m WHERE ts>=? AND ts<? AND symbol IN (${symbols.map(() => "?").join(",")}) ORDER BY ts,symbol LIMIT 30001`).all(Date.parse(`${start}T03:45:00Z`), Date.parse(`${end}T10:00:00Z`), ...symbols);
        return this.import({ ...input, dates, symbols, bars, source: "local bars_1m cache; original provider/adjustments not attested" });
    }
    async run(raw: unknown) {
        const input = object(raw);
        if (typeof input.datasetId !== "string")
            throw new PaperError("Select a dataset", 400);
        const row = this.db.prepare<[
            string
        ], {
            payload: string;
        }>("SELECT payload FROM backtest_datasets WHERE id=?").get(input.datasetId);
        if (!row)
            throw new PaperError("Dataset not found", 404);
        const dataset = parseDataset(JSON.parse(row.payload)), config = parseRun(input, dataset), key = fingerprint(dataset, config);
        const existing = this.db.prepare<[
            string
        ], {
            id: string;
        }>("SELECT id FROM backtest_runs WHERE fingerprint=?").get(key);
        if (existing)
            return this.result(existing.id);
        if (this.db.prepare<[
        ], {
            count: number;
        }>("SELECT count(*) AS count FROM backtest_runs").get()!.count >= 100)
            throw new PaperError("Saved evaluation limit reached (100)", 409);
        const result = object(await runWorker(dataset, config));
        if (result.fingerprint !== key)
            throw new Error("Evaluation worker returned a mismatched fingerprint");
        const id = randomUUID(), createdAt = Date.now();
        const summary = { id, createdAt, datasetId: dataset.hash, datasetName: dataset.name, startDate: config.startDate, endDate: config.endDate, holdoutDate: config.holdoutDate, strategies: config.strategies, synthetic: dataset.synthetic };
        this.db.prepare("INSERT INTO backtest_runs VALUES (?,?,?,?,?)").run(id, key, createdAt, JSON.stringify(summary), JSON.stringify({ ...result, id, createdAt, datasetName: dataset.name }));
        return this.result(id);
    }
    runs() { return this.db.prepare<[
    ], {
        summary: string;
    }>("SELECT summary FROM backtest_runs ORDER BY created_at DESC LIMIT 100").all().map(row => object(JSON.parse(row.summary))); }
    result(id: string): unknown {
        const row = this.db.prepare<[
            string
        ], {
            result: string;
        }>("SELECT result FROM backtest_runs WHERE id=?").get(id);
        if (!row)
            throw new PaperError("Evaluation not found", 404);
        return JSON.parse(row.result);
    }
}
