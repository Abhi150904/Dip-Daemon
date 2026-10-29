import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export function secret(env: NodeJS.ProcessEnv, name: string): string {
  if (env[name] && env[`${name}_FILE`]) throw new Error(`Use ${name} or ${name}_FILE, not both`);
  const path = env[`${name}_FILE`];
  return path ? readFileSync(path, "utf8").trim() : env[name] ?? "";
}
export function operationsSettings(env: NodeJS.ProcessEnv) {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max || env[key]?.trim() === "") throw new Error(`Invalid ${key}`);
    return value;
  };
  const authToken = secret(env, "AUTH_TOKEN"), appOrigin = env.APP_ORIGIN ?? "";
  if (authToken && !/^[A-Za-z0-9_-]{32,256}$/.test(authToken)) throw new Error("AUTH_TOKEN must contain 32–256 letters, digits, underscores or hyphens");
  if (appOrigin) {
    const url = new URL(appOrigin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== appOrigin || url.username || url.password) throw new Error("APP_ORIGIN must be an exact http(s) origin without a path");
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Remote APP_ORIGIN requires HTTPS");
  }
  const host = env.HOST ?? "127.0.0.1";
  const trustedProxyIps = (env.TRUST_PROXY_IPS ?? "127.0.0.1,::1,::ffff:127.0.0.1").split(",").map(v => v.trim()).filter(Boolean);
  if (trustedProxyIps.some(ip => !isIP(ip))) throw new Error("TRUST_PROXY_IPS requires exact IP addresses");
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && (!authToken || !appOrigin)) throw new Error("Non-loopback HOST requires AUTH_TOKEN(_FILE) and APP_ORIGIN");
  return { authToken, appOrigin, trustedProxyIps, backupDir: env.BACKUP_DIR ?? "data/backups", backupIntervalMinutes: number("BACKUP_INTERVAL_MIN", 60, 1, 10080), backupKeep: number("BACKUP_KEEP", 24, 1, 1000), shutdownMs: number("SHUTDOWN_TIMEOUT_MS", 20000, 1000, 120000) };
}
