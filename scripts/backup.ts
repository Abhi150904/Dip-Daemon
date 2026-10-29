import Database from "better-sqlite3";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Backups, restoreBackup, verifyBackup } from "../src/ops/backup.js";

config({ quiet: true });
const [command = "create", file, target] = process.argv.slice(2);
if (command === "verify" && file) console.log(JSON.stringify(verifyBackup(resolve(file))));
else if (command === "restore" && file && target) console.log(JSON.stringify({ restoredTo: restoreBackup(resolve(file), target) }));
else if (command === "create") {
  const db = new Database(process.env.DB_PATH ?? "data/harness.db", { fileMustExist: true });
  try { console.log(JSON.stringify({ backup: await new Backups(db, file ?? process.env.BACKUP_DIR ?? "data/backups", Number(process.env.BACKUP_KEEP ?? 24)).run() })); }
  finally { db.close(); }
} else throw new Error("Use backup create [directory], verify <backup.db>, or restore <backup.db> <new-target.db>");
