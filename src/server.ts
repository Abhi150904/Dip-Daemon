import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { cfg } from "./config.js";
import {
  computeStats,
  db,
  getCapital,
  latencyP50,
  latencyP90,
  latestGovernor,
  latestRankings,
  listSessions,
  recentDecisions,
  recentEvents,
  recentTrades,
  setCapital,
  skippedCountToday,
  todayEntries,
  todayFriction,
  todayPnl,
  tokensToday,
} from "./db.js";
import type { Engine } from "./engine.js";
import type { ReplayControl } from "./replay/control.js";
import { ReplayManager } from "./replay/manager.js";
import { barDayStart, buildFeatures } from "./data/features.js";
import { NIFTY50 } from "./symbols.js";
import { clock } from "./time.js";
import type { PaperExecutor } from "./executor/paper.js";
import { access, body, paperApi, requireLocalRequest, reply } from "./api/paper.js";
import { PaperError } from "./portfolio/types.js";
import type { PaperAutomation } from "./automation/paper.js";
import { automationApi } from "./api/automation.js";
import { Backtests } from "./backtest/store.js";
import { backtestApi } from "./api/backtest.js";
import { Health } from "./ops/runtime.js";
import { log } from "./ops/log.js";

const clients = new Set<ServerResponse>();
const clientRequests = new WeakMap<ServerResponse, IncomingMessage>();
let replayCtl: ReplayControl | null = null;
let manager: ReplayManager | null = null;

/** Replay passes a getter because a backward seek rebuilds its Engine. */
export function startServer(target: Engine | (() => Engine), replay?: ReplayControl, port = cfg.port, paper?: PaperExecutor, automation?: PaperAutomation, health = new Health()) {
  const backtests = new Backtests(db);
  const current = typeof target === "function" ? target : () => target;
  replayCtl = replay ?? null;
  manager = replay ? null : new ReplayManager();
  const server = createServer((req, res) => {
    const engine = current();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch { reply(res, 400, { error: "Invalid URL" }); return; }
    if (url.pathname === "/healthz" && req.method === "GET") return reply(res, db.open ? 200 : 503, { ok: db.open });
    if (["/login", "/auth/login", "/auth/logout"].includes(url.pathname)) { void access.route(req, res, url.pathname); return; }
    if (url.pathname === "/style.css" && req.method === "GET") return staticFile(res, url.pathname);
    try { requireLocalRequest(req); }
    catch (error) {
      const status = error instanceof PaperError ? error.status : 403;
      if (status === 401 && req.method === "GET" && req.headers.accept?.includes("text/html")) { res.writeHead(303, { Location: "/login" }); res.end(); return; }
      return reply(res, status, { error: error instanceof PaperError ? error.message : "Access denied" });
    }
    if (health.phase === "stopping") return reply(res, 503, { error: "Service is stopping; retry after restart" });
    const system = () => {
      const latestQuote = Math.max(0, ...[...engine.quotes.values()].map(q => q.ts));
      const quoteAgeMs = latestQuote ? Math.max(0, clock.now() - latestQuote) : null;
      return { ...health.snapshot(), database: db.open, authentication: access.enabled, market: { connected: !!engine.snapshot().session, quoteAgeMs, fresh: quoteAgeMs !== null && quoteAgeMs <= cfg.paper.quoteMaxAgeMs, ...engine.feed.status() } };
    };
    if (url.pathname === "/readyz" && req.method === "GET") return reply(res, health.snapshot().ready ? 200 : 503, { ready: health.snapshot().ready });
    if (url.pathname === "/api/backtests" || url.pathname.startsWith("/api/backtests/")) {
      void backtestApi(req, res, url.pathname, backtests, engine.dataSource); return;
    }
    if (url.pathname === "/api/dashboard" && req.method === "GET") {
      try {
        requireLocalRequest(req);
        const collect = () => {
          const snapshot = engine.snapshot();
          return { now: clock.now(), mode: paper ? "paper" : snapshot.mode, source: engine.dataSource, system: system(),
            market: { connected: snapshot.session, warmedUp: snapshot.warmedUp, universe: NIFTY50, broker: cfg.broker, model: cfg.model,
              quotes: [...engine.quotes.values()].map(q => { const f = buildFeatures(q.symbol, q); return { ...q, atrPercent: f && q.ltp ? f.atr1m / q.ltp * 100 : null, rvol: f?.volume.rvol20d ?? null }; }) },
            account: paper?.account() ?? null, positions: paper?.positions() ?? [], orders: paper?.orders() ?? [], trades: paper?.trades() ?? [],
            automation: automation?.status() ?? null, signals: automation?.signals() ?? [], runs: automation?.runs() ?? [],
            events: paper?.events() ?? [], strategyEvents: automation?.events() ?? [],
            history: manager?.sessions() ?? [], killed: snapshot.killed, replay: replayCtl?.state() ?? null };
        };
        return reply(res, 200, (paper?.wallet.db ?? db).transaction(collect).immediate());
      } catch (error) { return reply(res, error instanceof PaperError ? error.status : 500, { error: error instanceof PaperError ? error.message : "Dashboard snapshot unavailable" }); }
    }
    if (url.pathname.startsWith("/api/automation/") || url.pathname === "/api/signals" || url.pathname.startsWith("/api/signals/") || url.pathname === "/api/strategies") {
      void automationApi(req, res, url.pathname, automation); return;
    }
    if (url.pathname.startsWith("/api/paper/")) { void paperApi(req, res, url.pathname, paper); return; }
    if (url.pathname === "/api/health") return reply(res, 200, { ok: db.open, mode: paper ? "paper" : engine.snapshot().mode, ...system() });
    if (url.pathname === "/api/market/status") return json(res, { connected: !!engine.snapshot().session, quotes: engine.quotes.size, source: engine.dataSource, paper: !!paper });
    if (url.pathname === "/api/market/stocks") return json(res, [...engine.quotes.values()]);
    if (url.pathname === "/api/state") return json(res, { ...state(engine), paperAccount: paper?.account() });
    if (url.pathname === "/api/sessions" && manager) {
      return json(res, { live: listSessions(), sessions: manager.sessions(), running: manager.list() });
    }
    if (url.pathname === "/api/sessions/start" && req.method === "POST" && manager) {
      const m = manager;
      void readBody(req).then((raw) => {
        try {
          const body = JSON.parse(raw) as { date: string; speed?: number; wild?: boolean };
          json(res, { ok: true, replay: m.start(body.date, Number(body.speed ?? 60), !!body.wild) });
        } catch (e) {
          res.writeHead(400);
          res.end(String(e));
        }
      }).catch(() => { if (!res.headersSent) reply(res, 400, { error: "Invalid request" }); });
      return;
    }
    if (url.pathname === "/api/sessions/stop" && req.method === "POST" && manager) {
      const m = manager;
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw) as { date: string };
        json(res, { ok: m.stop(body.date) });
      }).catch(() => { if (!res.headersSent) reply(res, 400, { error: "Invalid request" }); });
      return;
    }
    if (url.pathname === "/api/replay" && req.method === "POST") {
      void readBody(req).then((raw) => {
        if (!replayCtl) {
          res.writeHead(404);
          res.end("not a replay");
          return;
        }
        try {
          replayCtl.command(JSON.parse(raw) as { speed?: number; paused?: boolean; seek?: number });
          json(res, { ok: true, replay: replayCtl.state() });
        } catch {
          res.writeHead(400);
          res.end("bad replay command");
        }
      }).catch(() => { if (!res.headersSent) reply(res, 400, { error: "Invalid request" }); });
      return;
    }
    if (url.pathname === "/api/kill" && req.method === "POST") {
      engine.kill();
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/unkill" && req.method === "POST") {
      engine.unkill();
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/jev" && req.method === "POST") {
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw || "{}") as { paused?: boolean };
        engine.setJevPaused(!!body.paused);
        json(res, { ok: true, jevPaused: engine.jevPaused });
      }).catch(() => { if (!res.headersSent) reply(res, 400, { error: "Invalid request" }); });
      return;
    }
    if (url.pathname === "/api/wild" && req.method === "POST") {
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw || "{}") as { on?: boolean };
        engine.setWildMode(!!body.on);
        json(res, { ok: true, wild: engine.wild });
      }).catch(() => { if (!res.headersSent) reply(res, 400, { error: "Invalid request" }); });
      return;
    }
    if (url.pathname === "/api/capital" && req.method === "POST") {
      void readBody(req).then((raw) => {
        try {
          const body = JSON.parse(raw) as { capital?: number };
          const capital = setCapital(Number(body.capital));
          json(res, { ok: true, capital });
        } catch {
          res.writeHead(400);
          res.end("bad capital");
        }
      }).catch(() => { if (!res.headersSent) reply(res, 400, { error: "Invalid request" }); });
      return;
    }
    if (url.pathname === "/events") return sse(req, res, engine);
    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "Unsupported method" });
    return staticFile(res, url.pathname);
  });
  server.listen(port, cfg.host, () => {
    const address = server.address();
    log("info", "http_listening", { host: cfg.host, port: address && typeof address !== "string" ? address.port : port, authenticated: access.enabled });
  });
  const timer = setInterval(() => { try { broadcast(current()); } catch (error) { log("error", "broadcast_failed", { error }); } }, replay ? 500 : 2000);
  server.on("close", () => { clearInterval(timer); manager?.stopAll(); });
  return server;
}

function state(engine: Engine) {
  const snap = engine.snapshot();
  const stats = computeStats();
  const curve = [...stats.curve];
  if (snap.openUnrealized) {
    if (curve.length === 1) curve[0] = { t: barDayStart(), eq: 0 };
    curve.push({ t: clock.now(), eq: stats.netPnl + snap.openUnrealized });
  }
  return {
    ...snap,
    todayPnl: todayPnl(),
    todayFriction: todayFriction(),
    todayEntries: todayEntries(),
    latencyP50: latencyP50(),
    latencyP90: latencyP90(),
    tokensToday: tokensToday(),
    skippedToday: skippedCountToday(),
    governor: latestGovernor(),
    rankings: latestRankings().map((r) => ({ side: r.side, payload: tryJson(r.payload) })),
    trades: recentTrades(80),
    decisions: recentDecisions(200),
    events: recentEvents(60),
    serverTime: clock.now(),
    replay: replayCtl?.state() ?? null,
    dailyLossCap: cfg.dailyLossCap,
    capital: getCapital(),
    stats,
    curve,
  };
}

function sse(req: IncomingMessage, res: ServerResponse, engine: Engine): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(state(engine))}\n\n`);
  clients.add(res);
  clientRequests.set(res, req);
  req.on("close", () => clients.delete(res));
}

function broadcast(engine: Engine): void {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(state(engine))}\n\n`;
  for (const c of clients) {
    try { const req = clientRequests.get(c); if (!req) throw new Error("Missing client"); access.require(req); c.write(payload); }
    catch { c.end(); clients.delete(c); }
  }
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function staticFile(res: ServerResponse, pathname: string): void {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  try {
    const root = resolve(process.cwd(), "web"), path = resolve(root, decodeURIComponent(file));
    if (!path.startsWith(root + sep)) throw new Error("Outside static root");
    const data = readFileSync(path);
    const ext = extname(path);
    const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

async function readBody(req: IncomingMessage): Promise<string> { return JSON.stringify(await body(req)); }
