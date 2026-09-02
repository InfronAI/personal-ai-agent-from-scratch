import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import Database from "better-sqlite3";

const directory = mkdtempSync(join(tmpdir(), "copilot-migration-test-"));
const databasePath = join(directory, "legacy.sqlite");
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE chat_turns (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    answer TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
legacy.close();
process.env.COPILOT_DATABASE_PATH = databasePath;

const { closeDatabase, database, databaseStatus } = await import(`../database.mjs?test=${Date.now()}`);

after(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("前向迁移可把旧数据库升级到最新协议且保留旧表", () => {
  const status = databaseStatus();
  assert.equal(status.schema_version, status.latest_schema_version);
  assert.equal(status.latest_schema_version, 13);
  const columns = new Set(database.prepare("PRAGMA table_info(chat_turns)").all().map(column => column.name));
  assert.equal(columns.has("trace_id"), true);
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  for (const name of ["local_users", "chat_sessions", "chat_turns", "memory_entries", "memory_settings", "artifacts", "feedback_scores", "eval_feedback_candidates", "eval_golden_items", "eval_evidence_snapshots", "eval_runs", "user_onboarding", "instance_setup", "schema_migrations"]) {
    assert.equal(tables.has(name), true, `${name} 应存在`);
  }
  const memoryColumns = new Set(database.prepare("PRAGMA table_info(memory_entries)").all().map(column => column.name));
  for (const name of ["content", "memory_key", "status", "importance", "confidence", "expires_at", "superseded_by", "policy_version"]) {
    assert.equal(memoryColumns.has(name), true, `memory_entries.${name} 应存在`);
  }
  const candidateColumns = new Set(database.prepare("PRAGMA table_info(eval_feedback_candidates)").all().map(column => column.name));
  assert.equal(candidateColumns.has("input_json"), true, "反馈候选必须保存可复现输入");
  const evidenceColumns = new Set(database.prepare("PRAGMA table_info(eval_evidence_snapshots)").all().map(column => column.name));
  for (const name of ["user_id", "session_id", "request_id", "trace_id", "schema_version", "content_hash", "snapshot_json", "captured_at"]) {
    assert.equal(evidenceColumns.has(name), true, `eval_evidence_snapshots.${name} 应存在`);
  }
  const runColumns = new Set(database.prepare("PRAGMA table_info(eval_runs)").all().map(column => column.name));
  for (const name of ["user_id", "parent_run_id", "profile", "dataset_ids_json", "execution_status", "lifecycle_status", "gate_status", "summary_json", "result_json", "log_text"]) {
    assert.equal(runColumns.has(name), true, `eval_runs.${name} 应存在`);
  }
});
