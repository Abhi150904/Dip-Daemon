import { setTimeout as pause } from "node:timers/promises";
import { log } from "./log.js";

export class Health {
  readonly startedAt = Date.now();
  phase: "starting" | "running" | "stopping" = "running";
  lastTick: number | null = null;
  failures = 0;
  backup: { lastSuccess: number | null; lastFailure: number | null } | null = null;
  snapshot() {
    const stalled = this.lastTick !== null && Date.now() - this.lastTick > 30000;
    return { ready: this.phase === "running" && !stalled, phase: this.phase, uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000), lastTick: this.lastTick, failures: this.failures, backup: this.backup, backupHealthy: this.backup ? this.backup.lastFailure === null || (this.backup.lastSuccess ?? 0) > this.backup.lastFailure : null };
  }
}
export class ServiceLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  constructor(private readonly work: () => Promise<void>, private readonly health: Health, private readonly intervalMs = 2000, private readonly component = "service") {}
  start() { if (!this.stopped && !this.timer && !this.pending) void this.step(); }
  private async step() {
    let delay = this.intervalMs;
    this.pending = Promise.resolve().then(this.work);
    try { await this.pending; this.health.lastTick = Date.now(); this.health.failures = 0; }
    catch (error) { this.health.failures++; delay = Math.min(60000, this.intervalMs * 2 ** Math.min(6, this.health.failures)); log("error", "service_tick_failed", { component: this.component, error, retryMs: delay }); }
    finally { this.pending = undefined; if (!this.stopped) this.timer = setTimeout(() => { this.timer = undefined; void this.step(); }, delay); }
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.pending?.catch(() => undefined); }
}

export function installLifecycle(options: { health: Health; timeoutMs: number; prepare: () => void; close: () => Promise<void>; exit?: (code: number) => void }) {
  let pending: Promise<void> | undefined;
  const exit = options.exit ?? (code => process.exit(code));
  const stop = (reason: string, code = 0) => {
    if (pending) return pending;
    options.health.phase = "stopping";
    log(code ? "error" : "info", "shutdown_started", { reason });
    pending = (async () => {
      const deadline = setTimeout(() => { log("error", "shutdown_deadline_exceeded"); exit(1); }, options.timeoutMs);
      try { options.prepare(); await options.close(); log("info", "shutdown_complete"); exit(code); }
      catch (error) { log("error", "shutdown_failed", { error }); exit(1); }
      finally { clearTimeout(deadline); }
    })();
    return pending;
  };
  const interrupt = () => { void stop("SIGINT"); }, terminate = () => { void stop("SIGTERM"); };
  const fatal = (error: unknown) => {
    log("error", "fatal_error", { error }); void stop("fatal", 1);
  };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  process.on("uncaughtException", fatal); process.on("unhandledRejection", fatal);
  process.stdout.on("error", () => undefined); process.stderr.on("error", () => undefined);
  return { stop, remove() { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("uncaughtException", fatal); process.off("unhandledRejection", fatal); } };
}
export async function waitForIdle(idle: () => boolean) { while (!idle()) await pause(20); }
