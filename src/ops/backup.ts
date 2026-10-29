import Database from "better-sqlite3";
import { constants, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, openSync, readSync, closeSync, chmodSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

function hash(path: string) {
  const fd = openSync(path, "r"), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(65536);
  try { let size: number; while ((size = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, size)); return hash.digest("hex"); }
  finally { closeSync(fd); }
}
export function inspectBackup(path: string) { return { tables: checkDatabase(path), sha256: hash(path), bytes: statSync(path).size }; }
async function inspectWorker(path: string): Promise<ReturnType<typeof inspectBackup>> {
  const worker = new Worker(new URL("./backup-worker.js", import.meta.url), { workerData: path, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Backup verification deadline exceeded")), 60000);
      worker.once("message", (raw: unknown) => {
        clearTimeout(timer);
        if (!raw || typeof raw !== "object" || !("sha256" in raw) || typeof raw.sha256 !== "string" || !("bytes" in raw) || typeof raw.bytes !== "number" || !("tables" in raw) || !Array.isArray(raw.tables) || !raw.tables.every((v: unknown) => typeof v === "string")) return reject(new Error("Invalid backup verification result"));
        resolve({ sha256: raw.sha256, bytes: raw.bytes, tables: raw.tables });
      });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.once("exit", () => { clearTimeout(timer); reject(new Error("Backup verification worker exited")); });
    });
  } finally { await worker.terminate(); }
}
export function checkDatabase(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const foreignKeys: unknown = db.pragma("foreign_key_check");
    if (db.pragma("integrity_check", { simple: true }) !== "ok" || !Array.isArray(foreignKeys) || foreignKeys.length) throw new Error("Backup database integrity check failed");
    const tables = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    if (tables.includes("paper_ledger")) {
      const cash = db.prepare<[], { n: number }>("SELECT COALESCE(SUM(cash_paise),0) AS n FROM paper_ledger").get()?.n ?? 0;
      const reserved = db.prepare<[], { n: number }>("SELECT COALESCE(SUM(reserved_paise),0) AS n FROM paper_orders WHERE status='open'").get()?.n ?? 0;
      if (cash < 0 || reserved > cash) throw new Error("Backup paper cash/reservation invariant failed");
    }
    return tables;
  } finally { db.close(); }
}
export function verifyBackup(path: string) {
  const raw: unknown = JSON.parse(readFileSync(`${path}.manifest.json`, "utf8"));
  if (!raw || typeof raw !== "object" || !("sha256" in raw) || raw.sha256 !== hash(path) || !("file" in raw) || raw.file !== basename(path)) throw new Error("Backup manifest/hash mismatch");
  return { file: basename(path), sha256: raw.sha256, tables: checkDatabase(path) };
}
/** Creates a new target only. Restore never replaces a running database or its WAL sidecars. */
export function restoreBackup(source: string, destination: string) {
  const evidence = verifyBackup(source);
  const target = resolve(destination);
  if ([target, `${target}-wal`, `${target}-shm`, `${target}-journal`].some(existsSync)) throw new Error("Restore target or sidecars already exist; choose a new path");
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  if (hash(target) !== evidence.sha256) throw new Error("Restored database hash does not match the verified backup");
  checkDatabase(target);
  return target;
}
export class Backups {
  private pending: Promise<string> | undefined;
  lastSuccess: number | null = null;
  lastFailure: number | null = null;
  constructor(private readonly db: Database.Database, readonly directory: string, private readonly keep = 24) {
    if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new Error("Backup retention must be 1–1000");
  }
  run(): Promise<string> {
    if (this.pending) return this.pending;
    this.pending = this.create().then(path => { this.lastSuccess = Date.now(); return path; }, error => { this.lastFailure = Date.now(); throw error; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async drain() { await this.pending?.catch(() => undefined); }
  private async create() {
    const dir = resolve(this.directory); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `dipdaemon-${Date.now()}-${randomUUID()}.db`, path = join(dir, name), partial = `${path}.partial`;
    try {
      await this.db.backup(partial);
      chmodSync(partial, 0o600);
      const { tables, sha256, bytes } = await inspectWorker(partial);
      renameSync(partial, path);
      writeFileSync(`${path}.manifest.json`, JSON.stringify({ version: 1, file: name, createdAt: new Date().toISOString(), sha256, bytes, tables }) + "\n", { flag: "wx", mode: 0o600 });
      const completed = readdirSync(dir).filter(n => /^dipdaemon-\d+-[a-f0-9-]{36}\.db\.manifest\.json$/.test(n)).sort((a, b) => b.localeCompare(a));
      for (const old of completed.slice(this.keep)) {
        const file = join(dir, old.slice(0, -14));
        // Only completed, generated pairs are pruned; never scan or recursively delete user directories.
        const checked = await inspectWorker(file);
        const manifest: unknown = JSON.parse(readFileSync(`${file}.manifest.json`, "utf8"));
        if (!manifest || typeof manifest !== "object" || !("sha256" in manifest) || manifest.sha256 !== checked.sha256) throw new Error("Retention found an unverified backup; no further pruning");
        unlinkSync(`${file}.manifest.json`); unlinkSync(file);
      }
      return path;
    } finally { if (existsSync(partial)) unlinkSync(partial); }
  }
}
