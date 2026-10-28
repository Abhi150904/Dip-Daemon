export type TradingMode = "observe" | "paper" | "live";

export function parseTradingMode(value: string | undefined): TradingMode {
  if (value === undefined) return "observe";
  if (value === "observe" || value === "paper" || value === "live") return value;
  throw new Error("TRADING_MODE must be observe, paper, or live");
}

export function requireSupportedMode(mode: TradingMode): void {
  if (mode === "live") {
    throw new Error("TRADING_MODE=live is disabled: live execution is deferred");
  }
}

/** No environment variable authorizes real orders during the foundation phases. */
export function blockLiveOrder(): void {
  throw new Error("Live broker order mutations are disabled during DipDaemon foundation development");
}
