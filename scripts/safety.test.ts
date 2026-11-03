import './test-env.js';
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTradingMode, requireSupportedMode } from "../src/execution-policy.js";

test("sandbox order mutations are restricted to Kite sandbox routes", async () => {
  const { ZerodhaClient } = await import("../src/zerodha/client.js");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, options) => {
    calls.push(`${options?.method} ${input}`);
    assert.equal(options?.redirect, "error");
    if (String(input).endsWith("/instruments/NSE")) return new Response(
      "instrument_token,tradingsymbol,segment,instrument_type,tick_size,lot_size\n1,INFY,NSE,EQ,0.05,1"
    );
    if (String(input).includes("/quote?")) return Response.json({ status: "success", data: { "NSE:NIFTY 50": { instrument_token: 2 } } });
    return Response.json({ status: "success", data: options?.method === "GET" ? { user_id: "demo" } : { order_id: "123" } });
  };
  try {
    const client = ZerodhaClient.sandboxClient("fixture");
    await client.loadScrips();
    assert.equal(client.getInstrument("INFY")?.token, "1");
    assert.ok(client.getInstrument("Nifty 50"));
    const result = await client.place({ segment: "nse_cm", tradingSymbol: "INFY", side: "buy", qty: 1, price: 100, tag: "fixture" });
    assert.equal(result.orderId, "123");
    await client.cancel("123");
    assert.deepEqual(calls, [
      "GET https://sandbox.kite.trade/oms/user/profile",
      "undefined https://sandbox.kite.trade/instruments/NSE",
      "GET https://sandbox.kite.trade/oms/quote?i=NSE%3ANIFTY%2050",
      "POST https://sandbox.kite.trade/oms/orders/regular",
      "DELETE https://sandbox.kite.trade/oms/orders/regular/123",
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test("execution modes default safely and unsupported modes fail closed", () => {
  assert.equal(parseTradingMode(undefined), "observe");
  requireSupportedMode(parseTradingMode(undefined));
  requireSupportedMode(parseTradingMode("paper"));
  assert.throws(() => requireSupportedMode(parseTradingMode("live")), /disabled/);
  for (const value of ["", "LIVE", "unknown"]) assert.throws(() => parseTradingMode(value), /TRADING_MODE/);
});

test("both real broker clients reject every trading endpoint before network access", async () => {
  process.env.TRADING_MODE = "observe";
  process.env.MODEL = "jev";
  process.env.ALLOW_MOCK_TRADING = "1";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Unexpected network request");
  };
  try {
    const { KotakClient } = await import("../src/kotak/client.js");
    const { ZerodhaClient } = await import("../src/zerodha/client.js");
    const { cfg } = await import("../src/config.js");
    const order = { segment: "nse_cm", tradingSymbol: "INFY", side: "buy", qty: 1, price: 100, tag: "safety" } as const;
    for (const mode of ["observe", "paper"] as const) {
      cfg.tradingMode = mode;
      for (const client of [new KotakClient(), new ZerodhaClient()]) {
        await assert.rejects(client.place(order), /mutations are disabled/);
        await assert.rejects(client.modify({ ...order, orderId: "test-only" }), /mutations are disabled/);
        await assert.rejects(client.cancel("test-only"), /mutations are disabled/);
      }
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
