import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { config } from "./config.mjs";
import { LATEST_DATABASE_VERSION, runDatabaseMigrations } from "./database-migrations.mjs";

mkdirSync(dirname(config.database.path), { recursive: true });
export const database = new Database(config.database.path);
database.pragma("journal_mode = WAL");
database.pragma("synchronous = NORMAL");
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
const appliedMigrations = runDatabaseMigrations(database);

export function databaseStatus() {
  return {
    configured: true,
    provider: "sqlite",
    path: config.database.path,
    schema_version: Number(database.pragma("user_version", { simple: true })),
    latest_schema_version: LATEST_DATABASE_VERSION,
    migrations: appliedMigrations.map(item => ({ version: item.version, name: item.name, applied_at: item.applied_at }))
  };
}

export function closeDatabase() {
  if (database.open) database.close();
}
