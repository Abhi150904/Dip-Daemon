import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { body, reply } from "./paper.js";
import { PaperError } from "../portfolio/types.js";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/zerodha-sandbox.mjs", import.meta.url));
let submitting = false;

export async function sandboxApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const token = process.env.KITE_SANDBOX_ACCESS_TOKEN?.trim();
  if (path === "/api/sandbox" && req.method === "GET") return reply(res, 200, { enabled: Boolean(token) });
  if (!token) return reply(res, 409, { error: "Set KITE_SANDBOX_ACCESS_TOKEN and restart DipDaemon." });
  if (req.method !== "POST") return reply(res, 405, { error: "Use POST." });
  let ownsSubmission = false;
  try {
    const input = await body(req, 1024);
    if (!input || typeof input !== "object") throw new PaperError("Invalid sandbox request");
    let args: string[];
    if (path === "/api/sandbox/submit") {
      if (!("symbol" in input) || typeof input.symbol !== "string" || !/^[A-Z0-9&-]{1,30}$/.test(input.symbol) ||
          !("price" in input) || typeof input.price !== "number" || !Number.isFinite(input.price) || input.price <= 0 ||
          !("quantity" in input) || typeof input.quantity !== "number" || !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 10 ||
          !("tag" in input) || typeof input.tag !== "string" || !/^dd[a-f0-9]{16}$/.test(input.tag)) {
        throw new PaperError("Enter a symbol, positive limit price and 1–10 shares.");
      }
      if (submitting) throw new PaperError("Another sandbox submission is running.", 409);
      submitting = ownsSubmission = true;
      args = ["submit", input.symbol, String(input.price), String(input.quantity), input.tag];
    } else if (path === "/api/sandbox/recover" && "tag" in input && typeof input.tag === "string" && /^dd[a-f0-9]{16}$/.test(input.tag)) {
      args = ["recover", input.tag];
    } else if (path === "/api/sandbox/cancel" && "orderId" in input && typeof input.orderId === "string" && /^\d{1,25}$/.test(input.orderId)) {
      args = ["cancel", input.orderId];
    } else throw new PaperError("Invalid sandbox action or identifier.", 400);
    const { stdout } = await run(process.execPath, [script, ...args], { env: { KITE_SANDBOX_ACCESS_TOKEN: token }, timeout: 25000, windowsHide: true });
    return reply(res, 200, args[0] === "cancel" ? { requested: true } : JSON.parse(stdout));
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const tag = /Sandbox submission tag: (dd[a-f0-9]{16})/.exec(stderr)?.[1];
    return reply(res, error instanceof PaperError ? error.status : 502, {
      error: error instanceof PaperError ? error.message : tag ? "Submission unconfirmed. Recover by tag before retrying." : "Sandbox request failed. Check the sandbox session and order status.",
      tag,
    });
  } finally {
    if (ownsSubmission) submitting = false;
  }
}
