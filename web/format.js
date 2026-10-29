export const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
export function money(value, signed = false) {
  if (value === null || value === undefined || typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2,
    ...(signed ? { signDisplay: "exceptZero" } : {}) }).format(value / 100);
}
export function number(value, digits = 0) {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(value) : "—";
}
export function time(value, date = false) {
  return Number.isFinite(value) ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...(date ? { day: "2-digit", month: "short" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value) : "—";
}
export const tone = value => typeof value === "number" && value !== 0 ? value > 0 ? "positive" : "negative" : "";
export function riskStatus(account) {
  if (!account) return "Paper account unavailable";
  if (account.killed) return "Emergency stop active";
  if (account.halted) return "Daily loss halt";
  if (account.stalePrices) return "Valuation stale";
  return "Within limits";
}
