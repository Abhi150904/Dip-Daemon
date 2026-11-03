import './test-env.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import Database from "better-sqlite3";
import { Backups, restoreBackup, verifyBackup } from "../src/ops/backup.js";
import { operationsSettings, secret } from "../src/ops/settings.js";
import { Access } from "../src/ops/access.js";
import { Health, ServiceLoop, installLifecycle } from "../src/ops/runtime.js";
import { protectSecrets, redact } from "../src/ops/log.js";

const token = "test_only_not_a_real_credential_0123456789abcdef";
test("remote binding and secret settings fail closed", () => {
  assert.throws(() => operationsSettings({ HOST: "0.0.0.0" }), /requires/);
  assert.throws(() => operationsSettings({ AUTH_TOKEN: "short" }), /32/);
  assert.throws(() => operationsSettings({ AUTH_TOKEN: token, APP_ORIGIN: "http://example.com" }), /HTTPS/);
  assert.throws(() => operationsSettings({ BACKUP_KEEP: "0" }), /BACKUP_KEEP/);
  assert.throws(() => operationsSettings({ TRUST_PROXY_IPS: "*" }), /IP addresses/);
  assert.throws(() => secret({ AUTH_TOKEN: token, AUTH_TOKEN_FILE: "unused" }, "AUTH_TOKEN"), /not both/);
  assert.equal(operationsSettings({ HOST: "0.0.0.0", AUTH_TOKEN: token, APP_ORIGIN: "https://example.com" }).appOrigin, "https://example.com");
});

test("authentication protects reads and writes, cookies, origin and brute-force boundaries", async () => {
  const access = new Access(operationsSettings({ AUTH_TOKEN: token }));
  const server = createServer(async (req, res) => {
    if (await access.route(req, res, new URL(req.url ?? "/", "http://localhost").pathname)) return;
    try { access.require(req); res.end("private"); }
    catch (error) { res.writeHead(error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500); res.end("denied"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { method: "POST" })).status, 401);
    assert.equal((await fetch(base, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(base, { headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.test" } })).status, 403);
    const forgedHost = await new Promise<number | undefined>((resolve, reject) => { const req = httpRequest(base, { headers: { Authorization: `Bearer ${token}`, Host: "evil.test" } }, response => { response.resume(); resolve(response.statusCode); }); req.on("error", reject); req.end(); });
    assert.equal(forgedHost, 403);
    const signedIn = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base }, body: new URLSearchParams({ token }), redirect: "manual" });
    assert.equal(signedIn.status, 303);
    const setCookie = signedIn.headers.get("set-cookie"); assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0];
    assert.equal((await fetch(base, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(base, { headers: { Cookie: cookie + "tampered" } })).status, 401);
    const signedOut = await fetch(`${base}/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: base }, redirect: "manual" });
    assert.equal(signedOut.status, 303); assert.match(signedOut.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await fetch(base, { headers: { Cookie: cookie } })).status, 401);
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=wrong" })).status, 401);
    assert.equal((await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=wrong" })).status, 429);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("verified online backups restore to new paths, retain financial records and reject tampering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dipdaemon-backups-")), source = join(dir, "source.db"), backupDir = join(dir, "backups");
  const db = new Database(source); db.pragma("journal_mode=WAL");
  db.exec("CREATE TABLE paper_orders(id TEXT PRIMARY KEY,status TEXT,reserved_paise INTEGER); CREATE TABLE paper_ledger(cash_paise INTEGER); CREATE TABLE paper_positions(symbol TEXT,qty INTEGER); INSERT INTO paper_ledger VALUES(10000); INSERT INTO paper_orders VALUES('pending','open',2000); INSERT INTO paper_positions VALUES('INFY',3)");
  try {
    const backups = new Backups(db, backupDir, 2);
    const pending = backups.run(); assert.equal(backups.run(), pending);
    const first = await pending;
    const target = join(dir, "restored.db"); restoreBackup(first, target);
    const restored = new Database(target, { readonly: true });
    try { assert.deepEqual(restored.prepare("SELECT * FROM paper_ledger").all(), [{ cash_paise: 10000 }]); assert.deepEqual(restored.prepare("SELECT * FROM paper_positions").all(), [{ symbol: "INFY", qty: 3 }]); assert.deepEqual(restored.prepare("SELECT * FROM paper_orders").all(), [{ id: "pending", status: "open", reserved_paise: 2000 }]); }
    finally { restored.close(); }
    assert.throws(() => restoreBackup(first, target), /already exist/);
    writeFileSync(join(backupDir, "operator-notes.txt"), "keep");
    await backups.run(); const latest = await backups.run();
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(join(backupDir, "operator-notes.txt")), true);
    assert.equal(readdirSync(backupDir).filter(f => f.endsWith(".manifest.json")).length, 2);
    assert.ok(verifyBackup(latest).sha256);
    appendFileSync(latest, "tampered");
    assert.throws(() => verifyBackup(latest), /mismatch/);
    assert.throws(() => restoreBackup(latest, join(dir, "bad.db")), /mismatch/);
    assert.equal(existsSync(join(dir, "bad.db")), false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("HTTPS origin requires a trusted proxy; forwarded headers alone cannot authorize a connection", async () => {
  let access = new Access(operationsSettings({ AUTH_TOKEN: token, APP_ORIGIN: "https://ops.example" }));
  const server = createServer((req, res) => { try { access.require(req); res.end("ok"); } catch { res.writeHead(403); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const send = (forwarded: boolean) => new Promise<number | undefined>((resolve, reject) => { const req = httpRequest({ host: "127.0.0.1", port: address.port, headers: { Host: "ops.example", Authorization: `Bearer ${token}`, ...(forwarded ? { "X-Forwarded-Proto": "https" } : {}) } }, res => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end(); });
  try { assert.equal(await send(false), 403); assert.equal(await send(true), 200); access = new Access(operationsSettings({ AUTH_TOKEN: token, APP_ORIGIN: "https://ops.example", TRUST_PROXY_IPS: "192.0.2.1" })); assert.equal(await send(true), 403); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("serial service loop drains before stopping; lifecycle shutdown is idempotent", async () => {
  const health = new Health(); let active = 0, maxActive = 0, completed = 0;
  const loop = new ServiceLoop(async () => { active++; maxActive = Math.max(maxActive, active); await pause(15); active--; completed++; }, health, 1);
  loop.start(); loop.start(); await pause(40); await loop.stop(); const count = completed; await pause(20);
  assert.equal(maxActive, 1); assert.equal(completed, count); assert.ok(health.lastTick);
  let prepared = 0, closed = 0, exitCode: number | undefined;
  const lifecycle = installLifecycle({ health, timeoutMs: 1000, prepare() { prepared++; }, async close() { closed++; await pause(10); }, exit(code) { exitCode = code; } });
  try { const a = lifecycle.stop("test"); assert.equal(lifecycle.stop("repeat"), a); await a; assert.equal(prepared, 1); assert.equal(closed, 1); assert.equal(exitCode, 0); assert.equal(health.snapshot().ready, false); }
  finally { lifecycle.remove(); }
});

test("configured secrets and credentials are redacted from errors", () => {
  protectSecrets([token]);
  assert.equal(redact(`failure ${token}`), "failure [redacted]");
  assert.doesNotMatch(redact("token=private-value password=other-value Bearer header-value"), /private-value|other-value|header-value/);
});

test("real service process shuts down, restarts with the same account and exits nonzero on fatal errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dipdaemon-process-")), dbPath = join(dir, "service.db");
  const env = { ...process.env, DB_PATH: dbPath, KILL_PATH: join(dir, "kill"), BACKUP_DIR: join(dir, "backups"), AUTH_TOKEN: token, AUTH_TOKEN_FILE: "", APP_ORIGIN: "", HOST: "127.0.0.1", PORT: "0", TRADING_MODE: "paper", MODEL: "mock", KOTAK_ACCESS_TOKEN: "", KOTAK_UCC: "", ZERODHA_API_KEY: "", ZERODHA_ACCESS_TOKEN: "", RSS_FEEDS: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", PAPER_AUTOMATION_MODE: "off" };
  const boot = async (sandboxToken = "") => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/main.ts"); process.on("message", m => { if(m === "stop") process.emit("SIGTERM"); if(m === "crash") setImmediate(() => {throw new Error("test fatal");}); });'], { env: { ...env, KITE_SANDBOX_ACCESS_TOKEN: sandboxToken }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "";
    assert.ok(child.stdout && child.stderr);
    child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { output += String(chunk); });
    for (let i = 0; i < 600; i++) { const match = /"event":"http_listening","host":"127\.0\.0\.1","port":(\d+)/.exec(output); if (match) return { child, base: `http://127.0.0.1:${match[1]}`, output: () => output }; if (child.exitCode !== null) break; await pause(25); }
    child.kill(); throw new Error("Service failed to start: " + output);
  };
  let current: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    current = await boot();
    assert.equal((await fetch(`${current.base}/login`)).headers.get("referrer-policy"), "same-origin");
    assert.equal((await fetch(`${current.base}/api/paper/account`)).status, 401);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${current.base}/api/sandbox`)).status, 401);
    assert.deepEqual(await (await fetch(`${current.base}/api/sandbox`, { headers })).json(), { enabled: false });
    assert.equal((await fetch(`${current.base}/api/sandbox/submit`, { method: "POST", headers })).status, 409);
    const before: unknown = await (await fetch(`${current.base}/api/paper/account`, { headers })).json();
    const signIn = await fetch(`${current.base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), redirect: "manual" });
    const cookie = signIn.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
    const stream = await fetch(`${current.base}/events`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(8000) });
    const reader = stream.body?.getReader(); assert.ok(reader); assert.equal((await reader.read()).done, false);
    await fetch(`${current.base}/auth/logout`, { method: "POST", headers: { Cookie: cookie }, redirect: "manual" });
    while (!(await reader.read()).done) { /* Existing streams must close after session revocation. */ }
    const exit = once(current.child, "exit"); current.child.send("stop"); assert.equal((await exit)[0], 0);
    assert.match(current.output(), /shutdown_complete/);
    current = await boot("sandbox-test-token");
    assert.deepEqual(await (await fetch(`${current.base}/api/sandbox`, { headers })).json(), { enabled: true });
    assert.equal((await fetch(`${current.base}/sandbox.html`, { headers })).status, 200);
    assert.equal((await fetch(`${current.base}/api/sandbox/submit`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "INFY", price: 100, quantity: 11, tag: "dd0123456789abcdef" }),
    })).status, 422);
    const after: unknown = await (await fetch(`${current.base}/api/paper/account`, { headers })).json();
    assert.deepEqual(after, before);
    assert.equal((await fetch(`${current.base}/healthz`)).status, 200);
    const crashExit = once(current.child, "exit"); current.child.send("crash"); assert.equal((await crashExit)[0], 1);
    assert.doesNotMatch(current.output(), new RegExp(token));
    assert.ok(readdirSync(join(dir, "backups")).some(f => f.endsWith(".manifest.json")), current.output());
  } finally { if (current?.child.exitCode === null) current.child.kill(); rmSync(dir, { recursive: true, force: true }); }
});

test("market-data retries preserve stale timestamps and recover without a burst of requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dipdaemon-feed-"));
  Object.assign(process.env, { DB_PATH: join(dir, "feed.db"), HOST: "127.0.0.1", AUTH_TOKEN: "", AUTH_TOKEN_FILE: "", APP_ORIGIN: "", MODEL: "mock", TRADING_MODE: "observe" });
  const { LiveFeed } = await import("../src/data/feed.js");
  const { SimBroker } = await import("../src/replay/sim.js");
  const { db } = await import("../src/db.js");
  const originalNow = Date.now; let now = originalNow(), calls = 0;
  Date.now = () => now;
  try {
    const broker = new SimBroker(new Map());
    const q = { symbol: "INFY", token: "INFY", segment: "nse_cm", ts: now - 20000, ltp: 100, bid: 100, ask: 100, ltq: 1, volume: 1000, tbq: 0, tsq: 0, bids: [], asks: [], open: 100, high: 100, low: 100, close: 100, tickSize: .05 };
    broker.quotes = async () => { calls++; if (calls === 1) throw new Error("transient network failure"); return [{ ...q, ts: now }]; };
    const feed = new LiveFeed(broker, () => [{ token: "INFY", symbol: "INFY", segment: "nse_cm" }], () => [], false, false);
    feed.quotes.set("INFY", q);
    await assert.rejects(feed.tick(), /transient/);
    await feed.tick(); assert.equal(calls, 1); assert.equal(feed.quotes.get("INFY")?.ts, q.ts);
    now += 2001; await feed.tick(); assert.equal(calls, 2); assert.equal(feed.status().failures, 0); assert.equal(feed.quotes.get("INFY")?.ts, now);
  } finally { Date.now = originalNow; db.close(); rmSync(dir, { recursive: true, force: true }); }
});
