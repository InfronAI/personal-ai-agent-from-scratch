import crypto from "node:crypto";

import { database } from "./database.mjs";
import { AppError } from "./errors.mjs";

const runByOwner = database.prepare("SELECT * FROM eval_runs WHERE id = ? AND user_id = ? LIMIT 1");
const runsByOwner = database.prepare(`
  SELECT * FROM eval_runs
  WHERE user_id = ? AND (? IS NULL OR lifecycle_status = ?)
  ORDER BY updated_at DESC, id DESC LIMIT ?
`);

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicRun(row, { detail = false } = {}) {
  if (!row) return null;
  const value = {
    id: row.id,
    parent_run_id: row.parent_run_id,
    name: row.name,
    profile: row.profile,
    dataset_ids: parseJson(row.dataset_ids_json, []),
    execution_status: row.execution_status,
    lifecycle_status: row.lifecycle_status,
    gate_status: row.gate_status,
    report_run_id: row.report_run_id,
    summary: parseJson(row.summary_json, {}),
    error_message: row.error_message,
    created_at: row.created_at,
    queued_at: row.queued_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    archived_at: row.archived_at,
    updated_at: row.updated_at
  };
  if (detail) {
    value.result = parseJson(row.result_json, {});
    value.log = row.log_text;
  }
  return value;
}

function ownedRow(userId, runId) {
  const row = runByOwner.get(String(runId), String(userId));
  if (!row) throw new AppError("Eval Run 不存在", { code: "eval_run_not_found", status: 404, expose: true });
  return row;
}

export function createEvalRunRecord({ userId, name, profile, datasetIds, parentRunId = null }) {
  const id = `evr-${crypto.randomBytes(12).toString("hex")}`;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO eval_runs (
      id, user_id, parent_run_id, name, profile, dataset_ids_json,
      execution_status, lifecycle_status, gate_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'active', 'pending', ?, ?)
  `).run(id, String(userId), parentRunId, name, profile, JSON.stringify(datasetIds), now, now);
  return publicRun(runByOwner.get(id, String(userId)), { detail: true });
}

export function listEvalRunRecords({ userId, lifecycle = "active", limit = 100 }) {
  if (!["active", "archived", "all"].includes(lifecycle)) {
    throw new AppError("无效的 Eval Run 生命周期筛选", { code: "invalid_eval_run_lifecycle", status: 400, expose: true });
  }
  const normalized = lifecycle === "all" ? null : lifecycle;
  return runsByOwner
    .all(String(userId), normalized, normalized, Math.min(500, Math.max(1, Number(limit) || 100)))
    .map(row => publicRun(row));
}

export function evalRunRecord({ userId, runId, detail = true }) {
  return publicRun(ownedRow(userId, runId), { detail });
}

export function queueEvalRunRecord({ userId, runId, reportPath }) {
  const row = ownedRow(userId, runId);
  if (row.lifecycle_status !== "active" || row.execution_status !== "draft") {
    throw new AppError("只有有效 Draft 才能启动", { code: "eval_run_not_startable", status: 409, expose: true });
  }
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE eval_runs SET execution_status = 'queued', report_path = ?, queued_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(reportPath, now, now, row.id, String(userId));
  return evalRunRecord({ userId, runId });
}

export function startEvalRunRecord({ userId, runId }) {
  const row = ownedRow(userId, runId);
  if (row.execution_status !== "queued") {
    throw new AppError("Eval Run 不在等待队列中", { code: "eval_run_not_queued", status: 409, expose: true });
  }
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE eval_runs SET execution_status = 'running', started_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(now, now, row.id, String(userId));
  return evalRunRecord({ userId, runId });
}

export function appendEvalRunLog({ userId, runId, text, maximumCharacters = 65_536 }) {
  ownedRow(userId, runId);
  const chunk = String(text || "");
  if (!chunk) return;
  database.prepare(`
    UPDATE eval_runs
    SET log_text = substr(log_text || ?, -?), updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(chunk, maximumCharacters, new Date().toISOString(), String(runId), String(userId));
}

export function completeEvalRunRecord({ userId, runId, gateStatus, reportRunId, summary, result }) {
  const row = ownedRow(userId, runId);
  if (!["queued", "running"].includes(row.execution_status)) {
    throw new AppError("Eval Run 已结束", { code: "eval_run_already_terminal", status: 409, expose: true });
  }
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE eval_runs
    SET execution_status = 'completed', gate_status = ?, report_run_id = ?, summary_json = ?, result_json = ?,
        error_message = NULL, ended_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(gateStatus, reportRunId || null, JSON.stringify(summary || {}), JSON.stringify(result || {}), now, now, row.id, String(userId));
  return evalRunRecord({ userId, runId });
}

export function failEvalRunRecord({ userId, runId, errorMessage }) {
  const row = ownedRow(userId, runId);
  if (["completed", "failed", "cancelled"].includes(row.execution_status)) return publicRun(row, { detail: true });
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE eval_runs
    SET execution_status = 'failed', gate_status = 'failed', error_message = ?, ended_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(String(errorMessage || "Evaluation infrastructure failed").slice(0, 2000), now, now, row.id, String(userId));
  return evalRunRecord({ userId, runId });
}

export function cancelEvalRunRecord({ userId, runId }) {
  const row = ownedRow(userId, runId);
  if (!["queued", "running"].includes(row.execution_status)) {
    throw new AppError("只有等待中或运行中的 Eval Run 可以取消", { code: "eval_run_not_cancellable", status: 409, expose: true });
  }
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE eval_runs
    SET execution_status = 'cancelled', gate_status = 'pending', ended_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(now, now, row.id, String(userId));
  return evalRunRecord({ userId, runId });
}

export function updateEvalRunLifecycleRecord({ userId, runId, action }) {
  const row = ownedRow(userId, runId);
  if (!["archive", "restore"].includes(action)) {
    throw new AppError("无效的 Eval Run 生命周期操作", { code: "invalid_eval_run_action", status: 400, expose: true });
  }
  if (["queued", "running"].includes(row.execution_status)) {
    throw new AppError("运行中的 Eval Run 不能归档", { code: "eval_run_active_execution", status: 409, expose: true });
  }
  const now = new Date().toISOString();
  const lifecycle = action === "archive" ? "archived" : "active";
  database.prepare(`
    UPDATE eval_runs SET lifecycle_status = ?, archived_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(lifecycle, lifecycle === "archived" ? now : null, now, row.id, String(userId));
  return evalRunRecord({ userId, runId });
}

export function failInterruptedEvalRuns() {
  const now = new Date().toISOString();
  const result = database.prepare(`
    UPDATE eval_runs
    SET execution_status = 'failed', gate_status = 'failed',
        error_message = 'Evaluation process was interrupted by a service restart.', ended_at = ?, updated_at = ?
    WHERE execution_status IN ('queued', 'running')
  `).run(now, now);
  return Number(result.changes || 0);
}

export function evalRunStoreStatus() {
  const rows = database.prepare("SELECT execution_status, COUNT(*) AS count FROM eval_runs GROUP BY execution_status").all();
  return {
    configured: true,
    provider: "sqlite",
    schemaVersion: "copilot-eval-run.v1",
    counts: Object.fromEntries(rows.map(row => [row.execution_status, Number(row.count)]))
  };
}
