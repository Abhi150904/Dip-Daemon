import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTradingMode, requireSupportedMode } from "../src/execution-policy.js";

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
