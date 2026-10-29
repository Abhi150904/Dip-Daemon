import { cfg } from "./config.js";
import { insertEvent } from "./db.js";
import { log, redact } from "./ops/log.js";

export async function alert(kind: string, message: string): Promise<void> {
  message = redact(message);
  try {
    insertEvent(kind, message);
  } catch {
    /* never let logging throw */
  }
  log("warn", "alert", { kind, message });
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: `[${kind}] ${message}` }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    log("warn", "alert_delivery_failed", { error: e });
  }
}
