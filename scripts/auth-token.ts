import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const path = resolve(process.argv[2] ?? ".secrets/dashboard-token");
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
console.log(`Private access token created at ${path}. Existing files are never replaced; keep this file out of Git.`);
