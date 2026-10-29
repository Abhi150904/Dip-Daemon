let secrets: string[] = [];
export function protectSecrets(values: string[]) { secrets = values.filter(v => v.length >= 4).sort((a, b) => b.length - a.length); }
export function redact(value: string): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join("[redacted]");
  return result.replace(/(dipdaemon_session=)[^;\s]+/gi, "$1[redacted]").replace(/(Bearer\s+|token\s+)[^\s"<>]+/gi, "$1[redacted]")
    .replace(/((?:token|secret|password|api[_-]?key|authorization|sid)\s*[=:]\s*)[^\s&,}"<>]+/gi, "$1[redacted]");
}
export function log(level: "info" | "warn" | "error", event: string, detail: Record<string, unknown> = {}): void {
  try { process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...detail }, (key, value: unknown) => /token|secret|password|authorization|cookie/i.test(key) ? "[redacted]" : value instanceof Error ? { name: value.name, message: redact(value.message) } : typeof value === "string" ? redact(value) : value) + "\n"); } catch { /* A broken log sink must not recurse into the crash handler. */ }
}
