import type { IncomingMessage, ServerResponse } from "node:http";
import type { PaperExecutor } from "../executor/paper.js";
import { PaperError } from "../portfolio/types.js";
import { cfg } from "../config.js";
import { Access } from "../ops/access.js";
export const access = new Access(cfg.operations);

export function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
export async function body(req: IncomingMessage, maxBytes = 16384): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new PaperError("Use application/json", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) { req.resume(); throw new PaperError("Request body too large", 413); }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new PaperError("Invalid JSON", 400); }
}

export function requireLocalRequest(req: IncomingMessage): void {
    access.require(req);
}

export async function paperApi(req: IncomingMessage, res: ServerResponse, path: string, paper?: PaperExecutor): Promise<void> {
  try {
    requireLocalRequest(req);
    if (!paper) throw new PaperError("Paper account APIs require TRADING_MODE=paper", 409);
    if (req.method === "GET") {
      if (path === "/api/paper/account") return reply(res, 200, paper.account());
      if (path === "/api/paper/positions") return reply(res, 200, paper.positions());
      if (path === "/api/paper/orders") return reply(res, 200, paper.orders());
      if (path === "/api/paper/trades") return reply(res, 200, paper.trades());
      if (path === "/api/paper/events") return reply(res, 200, paper.events());
      if (path === "/api/paper/ledger") return reply(res, 200, paper.ledger());
      const match = /^\/api\/paper\/orders\/([a-f0-9-]+)$/.exec(path);
      if (match) return reply(res, 200, paper.order(match[1]));
    } else if (req.method === "POST" && path === "/api/paper/orders") {
      const order = paper.submit(await body(req));
      return reply(res, order.status === "rejected" ? 422 : 200, order);
    } else if (req.method === "POST") {
      const match = /^\/api\/paper\/orders\/([a-f0-9-]+)\/(cancel|modify)$/.exec(path);
      if (match) return reply(res, 200, match[2] === "cancel" ? paper.cancel(match[1]) : paper.modify(match[1], await body(req)));
    }
    throw new PaperError("Unknown paper endpoint or unsupported method", 404);
  } catch (error) {
    reply(res, error instanceof PaperError ? error.status : 500, { error: error instanceof PaperError ? error.message : "Paper account operation failed" });
  }
}
