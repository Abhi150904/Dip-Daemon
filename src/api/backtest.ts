import type { IncomingMessage, ServerResponse } from "node:http";
import type { Backtests } from "../backtest/store.js";
import { PaperError } from "../portfolio/types.js";
import { body, reply, requireLocalRequest } from "./paper.js";
import { object } from "../backtest/data.js";
export async function backtestApi(req: IncomingMessage, res: ServerResponse, path: string, service: Backtests, source: string) {
    try {
        requireLocalRequest(req);
        if (req.method === "GET") {
            if (path === "/api/backtests")
                return reply(res, 200, { datasets: service.datasets(), runs: service.runs() });
            const match = /^\/api\/backtests\/([a-f0-9-]{36})$/.exec(path);
            if (match)
                return reply(res, 200, service.result(match[1]));
        }
        if (req.method === "POST") {
            if (path === "/api/backtests/import")
                return reply(res, 200, service.import(await body(req, 4 * 1024 * 1024)));
            if (path === "/api/backtests/demo")
                return reply(res, 200, service.demo());
            if (path === "/api/backtests/capture") {
                const input = object(await body(req));
                return reply(res, 200, service.capture({ ...input, synthetic: source.includes("synthetic") ? true : input.synthetic }));
            }
            if (path === "/api/backtests/run")
                return reply(res, 200, await service.run(await body(req)));
        }
        throw new PaperError("Unknown evaluation endpoint or method", 404);
    }
    catch (error) {
        reply(res, error instanceof PaperError ? error.status : 500, { error: error instanceof PaperError ? error.message : "Evaluation failed; no paper account state changed" });
    }
}
