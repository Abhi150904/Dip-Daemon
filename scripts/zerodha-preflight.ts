import { cfg } from "../src/config.js";
import { redact } from "../src/ops/log.js";
import { ZerodhaClient } from "../src/zerodha/client.js";

async function main(): Promise<void> {
  if (!cfg.zerodhaApiKey || !cfg.zerodhaAccessToken) {
    throw new Error("Set ZERODHA_API_KEY and a fresh ZERODHA_ACCESS_TOKEN before running the preflight.");
  }
  const client = new ZerodhaClient();
  const session = await client.login();
  if (!session.sid) throw new Error("Kite returned no account identity.");

  const orders = await client.orders();
  const positions = await client.positions();
  const terminal = new Set(["COMPLETE", "CANCELLED", "REJECTED"]);
  console.log(JSON.stringify({
    authenticated: true,
    ordersToday: orders.length,
    nonterminalOrders: orders.filter(order => !terminal.has(order.status)).length,
    openPositions: positions.length,
  }, null, 2));
}

void main().catch(error => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
