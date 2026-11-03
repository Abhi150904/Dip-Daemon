import { existsSync } from "node:fs";

const token = process.env.KITE_SANDBOX_ACCESS_TOKEN;
if (!token?.trim()) {
  throw new Error("Set KITE_SANDBOX_ACCESS_TOKEN to run the demo bot.");
}
Object.assign(process.env, {
  DB_PATH: "data/kite-sandbox-bot.db",
  KILL_PATH: "data/kite-sandbox-bot.kill",
  TRADING_MODE: "observe",
  OPTIONS_MODE: "off",
  LIVE_QTY: "1",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_BOT_TOKEN_FILE: "",
  HOST: "127.0.0.1",
  PORT: "8082",
  APP_ORIGIN: "",
});

const { ZerodhaClient } = await import("../src/zerodha/client.js");
const { LiveExecutor } = await import("../src/executor/live.js");
const { Engine } = await import("../src/engine.js");
const { db } = await import("../src/db.js");
const { Health, ServiceLoop, installLifecycle, waitForIdle } = await import("../src/ops/runtime.js");
const { log, protectSecrets } = await import("../src/ops/log.js");
const { startServer } = await import("../src/server.js");
protectSecrets([token]);
const client = ZerodhaClient.sandboxClient(token);
const engine = new Engine(client, { exec: new LiveExecutor(client) });
const health = new Health();
health.phase = "starting";
const server = startServer(engine, undefined, 8082, undefined, undefined, health);
let initialized = false;
const loop = new ServiceLoop(async () => {
  if (!initialized) {
    if (existsSync("data/kite-sandbox-bot.kill")) throw new Error("Sandbox kill switch is active");
    await engine.start();
    initialized = true;
    if (health.phase !== "stopping") health.phase = "running";
    log("info", "kite_sandbox_bot_started");
  }
  await engine.tick();
}, health);
installLifecycle({
  health, timeoutMs: 20000,
  prepare() { engine.sandboxEntriesArmed = false; engine.shutdown(); },
  async close() {
    await loop.stop();
    await waitForIdle(() => engine.idle);
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
  },
});
loop.start();
