import type { IncomingMessage, ServerResponse } from "node:http";
import type { PaperAutomation } from "../automation/paper.js";
import { PaperError } from "../portfolio/types.js";
import { requireLocalRequest, body, reply } from "./paper.js";

export async function automationApi(req: IncomingMessage, res: ServerResponse, path: string, automation?: PaperAutomation): Promise<void> {
  try {
    requireLocalRequest(req);
    if (!automation) throw new PaperError("Strategy service is unavailable", 409);
    if (req.method === "GET") {
      if (path === "/api/automation/status") return reply(res, 200, automation.status());
      if (path === "/api/automation/runs") return reply(res, 200, automation.runs());
      if (path === "/api/automation/events") return reply(res, 200, automation.events());
      if (path === "/api/signals") return reply(res, 200, automation.signals());
      if (path === "/api/strategies") return reply(res, 200, {
        active: automation.config(), available: [
          { id: "vwap_momentum", version: "vwap-momentum-v1", requiresModel: false },
          { id: "jev", version: "jev-two-stage-v1", requiresModel: true },
        ],
      });
    } else if (req.method === "POST") {
      if (path === "/api/automation/config") return reply(res, 200, automation.configure(await body(req)));
      if (path === "/api/automation/scan") return reply(res, 200, await automation.scan());
      const match = /^\/api\/signals\/([a-f0-9-]+)\/(approve|reject)$/.exec(path);
      if (match) {
        const result = match[2] === "approve" ? automation.approve(match[1]) : automation.reject(match[1]);
        return reply(res, result.status === "rejected" ? 422 : 200, result);
      }
    }
    throw new PaperError("Unknown strategy endpoint or method", 404);
  } catch (error) {
    reply(res, error instanceof PaperError ? error.status : 500, { error: error instanceof PaperError ? error.message : "Strategy operation failed" });
  }
}
