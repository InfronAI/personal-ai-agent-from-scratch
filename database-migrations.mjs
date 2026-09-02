import crypto from "node:crypto";

const migrations = Object.freeze([
  {
    version: 1,
    name: "会话与对话轮次",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS chat_sessions_user_time_idx
          ON chat_sessions(user_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS chat_turns (
          request_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          answer TEXT NOT NULL,
          trace_id TEXT,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS chat_turns_session_time_idx
          ON chat_turns(session_id, created_at, request_id);
      `);
    }
  },
  {
    version: 2,
    name: "对话轮次 Trace 关联",
    up(database) {
      const columns = new Set(database.prepare("PRAGMA table_info(chat_turns)").all().map(column => column.name));
      if (!columns.has("trace_id")) database.exec("ALTER TABLE chat_turns ADD COLUMN trace_id TEXT");
    }
  },
  {
    version: 3,
    name: "长期记忆与用户设置",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS memory_entries (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          trace_id TEXT,
          kind TEXT NOT NULL,
          user_message TEXT NOT NULL,
          assistant_response TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_accessed_at TEXT,
          access_count INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1
        ) STRICT;
        CREATE INDEX IF NOT EXISTS memory_entries_user_active_idx
          ON memory_entries(user_id, active, updated_at DESC);
        CREATE INDEX IF NOT EXISTS memory_entries_session_idx
          ON memory_entries(user_id, session_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS memory_settings (
          user_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    }
  },
  {
    version: 4,
    name: "Artifact 元数据",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          trace_id TEXT,
          name TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          kind TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          file_name TEXT NOT NULL,
          storage_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          content_text TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS artifacts_user_time_idx
          ON artifacts(user_id, active, created_at DESC);
        CREATE INDEX IF NOT EXISTS artifacts_session_idx
          ON artifacts(user_id, session_id, active, created_at DESC);
      `);
    }
  },
  {
    version: 5,
    name: "用户反馈 Score",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS feedback_scores (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          score_name TEXT NOT NULL,
          score_value REAL NOT NULL,
          data_type TEXT NOT NULL,
          comment TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          sync_status TEXT NOT NULL DEFAULT 'pending',
          sync_error TEXT,
          synced_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, request_id, score_name)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS feedback_user_time_idx
          ON feedback_scores(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS feedback_trace_idx
          ON feedback_scores(user_id, trace_id, updated_at DESC);
      `);
    }
  },
  {
    version: 6,
    name: "本地用户名身份",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS local_users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          normalized_username TEXT NOT NULL UNIQUE,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS local_users_active_login_idx
          ON local_users(active, last_login_at DESC);
      `);
    }
  },
  {
    version: 7,
    name: "长期记忆生命周期",
    up(database) {
      const columns = new Set(database.prepare("PRAGMA table_info(memory_entries)").all().map(column => column.name));
      const additions = [
        ["content", "TEXT NOT NULL DEFAULT ''"],
        ["memory_key", "TEXT NOT NULL DEFAULT ''"],
        ["status", "TEXT NOT NULL DEFAULT 'active'"],
        ["importance", "REAL NOT NULL DEFAULT 0.5"],
        ["confidence", "REAL NOT NULL DEFAULT 1.0"],
        ["expires_at", "TEXT"],
        ["superseded_by", "TEXT"],
        ["policy_version", "TEXT NOT NULL DEFAULT 'memory-write.v1'"]
      ];
      for (const [name, definition] of additions) {
        if (!columns.has(name)) database.exec(`ALTER TABLE memory_entries ADD COLUMN ${name} ${definition}`);
      }
      database.exec(`
        UPDATE memory_entries
        SET content = CASE WHEN content = '' THEN user_message ELSE content END,
            memory_key = CASE WHEN memory_key = '' THEN id ELSE memory_key END,
            status = CASE WHEN active = 1 THEN 'active' ELSE 'deleted' END
        WHERE content = '' OR memory_key = '';
        CREATE INDEX IF NOT EXISTS memory_entries_user_lifecycle_idx
          ON memory_entries(user_id, status, expires_at, updated_at DESC);
        CREATE INDEX IF NOT EXISTS memory_entries_user_key_idx
          ON memory_entries(user_id, memory_key, status, updated_at DESC);
      `);
    }
  },
  {
    version: 8,
    name: "用户反馈候选与 Golden Set",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS eval_feedback_candidates (
          id TEXT PRIMARY KEY,
          feedback_id TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          trace_id TEXT,
          prompt TEXT NOT NULL,
          actual_output TEXT NOT NULL,
          score_value REAL NOT NULL,
          comment TEXT,
          routing_json TEXT NOT NULL DEFAULT '{}',
          review_status TEXT NOT NULL DEFAULT 'candidate',
          failure_codes_json TEXT NOT NULL DEFAULT '[]',
          expected_output_json TEXT,
          expected_route_json TEXT,
          reviewer TEXT,
          reviewed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(request_id) REFERENCES chat_turns(request_id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS eval_feedback_candidates_user_status_idx
          ON eval_feedback_candidates(user_id, review_status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS eval_feedback_candidates_trace_idx
          ON eval_feedback_candidates(user_id, trace_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS eval_golden_items (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL UNIQUE REFERENCES eval_feedback_candidates(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          dataset_name TEXT NOT NULL,
          item_version INTEGER NOT NULL DEFAULT 1,
          item_json TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS eval_golden_items_user_active_idx
          ON eval_golden_items(user_id, active, updated_at DESC);
      `);
    }
  },
  {
    version: 9,
    name: "反馈候选可复现输入",
    up(database) {
      const columns = new Set(database.prepare("PRAGMA table_info(eval_feedback_candidates)").all().map(column => column.name));
      if (!columns.has("input_json")) {
        database.exec("ALTER TABLE eval_feedback_candidates ADD COLUMN input_json TEXT NOT NULL DEFAULT '{\"messages\":[]}'");
      }
      const update = database.prepare("UPDATE eval_feedback_candidates SET input_json = ? WHERE id = ?");
      for (const row of database.prepare("SELECT id, prompt, input_json FROM eval_feedback_candidates").all()) {
        let messages = [];
        try { messages = JSON.parse(row.input_json)?.messages || []; } catch { messages = []; }
        if (!messages.length) update.run(JSON.stringify({ messages: [{ role: "user", content: row.prompt }] }), row.id);
      }
    }
  },
  {
    version: 10,
    name: "历史用户反馈进入 Eval 候选池",
    up(database) {
      const rows = database.prepare(`
        SELECT f.id AS feedback_id, f.user_id, f.session_id, f.request_id, f.trace_id,
               f.score_value, f.comment, f.created_at, f.updated_at,
               t.prompt, t.answer, t.result_json
        FROM feedback_scores f
        JOIN chat_turns t ON t.request_id = f.request_id AND t.user_id = f.user_id
        LEFT JOIN eval_feedback_candidates c ON c.feedback_id = f.id
        WHERE c.id IS NULL
        ORDER BY f.created_at, f.id
      `).all();
      const sessionTurns = database.prepare(`
        SELECT request_id, prompt, answer FROM chat_turns
        WHERE session_id = ? AND user_id = ? ORDER BY created_at, request_id
      `);
      const insert = database.prepare(`
        INSERT OR IGNORE INTO eval_feedback_candidates (
          id, feedback_id, user_id, session_id, request_id, trace_id, prompt, actual_output,
          score_value, comment, routing_json, input_json, review_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
      `);
      for (const row of rows) {
        const messages = [];
        for (const turn of sessionTurns.all(row.session_id, row.user_id)) {
          messages.push({ role: "user", content: turn.prompt });
          if (turn.request_id === row.request_id) break;
          messages.push({ role: "assistant", content: turn.answer });
        }
        const bounded = messages.slice(-25);
        if (bounded[0]?.role === "assistant") bounded.shift();
        let result = {};
        try { result = JSON.parse(row.result_json); } catch { result = {}; }
        const candidateId = `gfc-${crypto.createHash("sha256").update(`${row.user_id}\u0000${row.feedback_id}`).digest("hex").slice(0, 24)}`;
        insert.run(
          candidateId,
          row.feedback_id,
          row.user_id,
          row.session_id,
          row.request_id,
          row.trace_id,
          row.prompt,
          row.answer,
          row.score_value,
          row.comment,
          JSON.stringify(result.routing || result.intent || {}),
          JSON.stringify({ messages: bounded.length ? bounded : [{ role: "user", content: row.prompt }] }),
          row.created_at,
          row.updated_at
        );
      }
    }
  },
  {
    version: 11,
    name: "首次配置向导与实例配置管理员",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS user_onboarding (
          user_id TEXT NOT NULL,
          onboarding_version TEXT NOT NULL,
          completed_at TEXT,
          last_verified_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(user_id, onboarding_version)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS user_onboarding_user_idx
          ON user_onboarding(user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS instance_setup (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          owner_user_id TEXT,
          claimed_at TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO instance_setup(singleton, owner_user_id, claimed_at, updated_at)
        VALUES (1, NULL, NULL, '1970-01-01T00:00:00.000Z');
      `);
    }
  },
  {
    version: 12,
    name: "反馈评估证据快照",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS eval_evidence_snapshots (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          trace_id TEXT,
          schema_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          UNIQUE(user_id, request_id),
          FOREIGN KEY(request_id) REFERENCES chat_turns(request_id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS eval_evidence_snapshots_user_time_idx
          ON eval_evidence_snapshots(user_id, captured_at DESC);
        CREATE INDEX IF NOT EXISTS eval_evidence_snapshots_trace_idx
          ON eval_evidence_snapshots(user_id, trace_id);
      `);
    }
  },
  {
    version: 13,
    name: "Eval Run 生命周期",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS eval_runs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          parent_run_id TEXT REFERENCES eval_runs(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          profile TEXT NOT NULL,
          dataset_ids_json TEXT NOT NULL,
          execution_status TEXT NOT NULL CHECK(execution_status IN ('draft', 'queued', 'running', 'completed', 'failed', 'cancelled')),
          lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_status IN ('active', 'archived')),
          gate_status TEXT NOT NULL DEFAULT 'pending' CHECK(gate_status IN ('pending', 'passed', 'failed')),
          report_path TEXT,
          report_run_id TEXT,
          summary_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT NOT NULL DEFAULT '{}',
          error_message TEXT,
          log_text TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          queued_at TEXT,
          started_at TEXT,
          ended_at TEXT,
          archived_at TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS eval_runs_user_lifecycle_time_idx
          ON eval_runs(user_id, lifecycle_status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS eval_runs_user_execution_idx
          ON eval_runs(user_id, execution_status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS eval_runs_parent_idx
          ON eval_runs(user_id, parent_run_id);
      `);
    }
  }
]);

export const LATEST_DATABASE_VERSION = migrations.at(-1).version;

export function runDatabaseMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map(row => row.version));
  const record = database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)");
  const apply = database.transaction(migration => {
    migration.up(database);
    record.run(migration.version, migration.name, new Date().toISOString());
  });
  for (const migration of migrations) {
    if (!applied.has(migration.version)) apply(migration);
  }
  database.pragma(`user_version = ${LATEST_DATABASE_VERSION}`);
  return database.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all();
}
