import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PaperError } from "../portfolio/types.js";
import type { operationsSettings } from "./settings.js";

const cookieName = "dipdaemon_session";
export class Access {
  private attempts = new Map<string, { count: number; until: number }>();
  private sessions = new Map<string, number>();
  private readonly digest: Buffer;
  constructor(private readonly options: ReturnType<typeof operationsSettings>) { this.digest = createHash("sha256").update(options.authToken).digest(); }
  get enabled() { return !!this.options.authToken; }
  origin(req: IncomingMessage) {
    const host = req.headers.host;
    const expected = this.options.appOrigin || (host && ["localhost", "127.0.0.1", "[::1]"].some(name => host === `${name}:${req.socket.localPort}`) ? `http://${host}` : "");
    if (!expected || host !== new URL(expected).host || (req.headers.origin && req.headers.origin !== expected) || req.headers["sec-fetch-site"] === "cross-site") throw new PaperError("Local configured same-origin access required", 403);
    if (expected.startsWith("https:") && !("encrypted" in req.socket && req.socket.encrypted === true) && !(this.options.trustedProxyIps.includes(req.socket.remoteAddress ?? "") && req.headers["x-forwarded-proto"] === "https")) throw new PaperError("HTTPS via a configured trusted proxy is required", 403);
    if (!this.enabled && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) throw new PaperError("Local access required", 403);
  }
  private matches(value: string) { return !!value && value.length <= 256 && timingSafeEqual(createHash("sha256").update(value).digest(), this.digest); }
  private session(req: IncomingMessage) { return req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? ""; }
  require(req: IncomingMessage) {
    this.origin(req);
    if (!this.enabled) return;
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    const cookie = this.session(req), expires = this.sessions.get(cookie) ?? 0;
    if (!this.matches(bearer) && expires <= Date.now()) { this.sessions.delete(cookie); throw new PaperError("Authentication required", 401); }
  }
  async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!["/login", "/auth/login", "/auth/logout"].includes(path)) return false;
    try {
      this.origin(req);
      if (!this.enabled) { res.writeHead(303, { Location: "/" }); res.end(); return true; }
      if (path === "/login" && req.method === "GET") { this.page(res); return true; }
      if (req.method !== "POST") throw new PaperError("Unsupported authentication method", 405);
      if (path === "/auth/logout") { this.require(req); this.sessions.delete(this.session(req)); this.cookie(res, "", 0); res.writeHead(303, { Location: "/login" }); res.end(); return true; }
      const key = req.socket.remoteAddress ?? "unknown", now = Date.now();
      for (const [ip, limit] of this.attempts) if (limit.until <= now) this.attempts.delete(ip);
      const limit = this.attempts.get(key) ?? { count: 0, until: now + 60000 };
      if (limit.count >= 5 || this.attempts.size > 1000) throw new PaperError("Too many login attempts; retry in a minute", 429);
      limit.count++; this.attempts.set(key, limit);
      if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) throw new PaperError("Use the sign-in form", 415);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > 1024) { req.resume(); throw new PaperError("Login request too large", 413); } chunks.push(Buffer.from(chunk)); }
      const value = new URLSearchParams(Buffer.concat(chunks).toString()).get("token") ?? "";
      if (!this.matches(value)) { this.page(res, 401); return true; }
      this.attempts.delete(key);
      for (const [id, expires] of this.sessions) if (expires <= now) this.sessions.delete(id);
      if (this.sessions.size >= 1000) { const first = this.sessions.keys().next().value; if (first) this.sessions.delete(first); }
      const id = randomBytes(32).toString("hex"); this.sessions.set(id, now + 28800000);
      this.cookie(res, id, 28800); res.writeHead(303, { Location: "/" }); res.end(); return true;
    } catch (error) { res.writeHead(error instanceof PaperError ? error.status : 500, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: error instanceof PaperError ? error.message : "Authentication unavailable" })); return true; }
  }
  private cookie(res: ServerResponse, value: string, age: number) { res.setHeader("Set-Cookie", `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.options.appOrigin.startsWith("https:") ? "; Secure" : ""}`); }
  private page(res: ServerResponse, status = 200) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · DipDaemon</title><link rel="stylesheet" href="/style.css"></head><body><main class="login"><h1>DipDaemon</h1><p>Sign in to your research workspace.</p><section class="panel section-gap"><form action="/auth/login" method="post" class="panel-body"><h2>Workspace access</h2><p class="ticket-note">Use the access token from your private secret file. Real orders remain disabled.</p>${status === 401 ? '<p class="notice danger" role="alert">Token not accepted. Try again.</p>' : ''}<div class="field section-gap"><label for="token">Access token</label><input id="token" name="token" type="password" required minlength="32" maxlength="256" autocomplete="current-password"></div><button class="button primary">Sign in</button></form></section></main></body></html>`);
  }
}
