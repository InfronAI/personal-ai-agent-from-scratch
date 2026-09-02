import crypto from "node:crypto";

import { database } from "./database.mjs";
import { AppError } from "./errors.mjs";

const upsertFeedback = database.prepare(`
  INSERT INTO feedback_scores (
    id, user_id, session_id, request_id, trace_id, score_name, score_value,
    data_type, comment, metadata_json, sync_status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  ON CONFLICT(user_id, request_id, score_name) DO UPDATE SET
    score_value = excluded.score_value,
    data_type = excluded.data_type,
    comment = excluded.comment,
    metadata_json = excluded.metadata_json,
    sync_status = 'pending',
    sync_error = NULL,
    synced_at = NULL,
    updated_at = excluded.updated_at
`);
const feedbackById = database.prepare("SELECT * FROM feedback_scores WHERE id = ? AND user_id = ? LIMIT 1");
const feedbackByRequest = database.prepare("SELECT * FROM feedback_scores WHERE request_id = ? AND user_id = ? ORDER BY updated_at DESC");
const markSynced = database.prepare("UPDATE feedback_scores SET sync_status = 'synced', sync_error = NULL, synced_at = ?, updated_at = ? WHERE id = ?");
const markFailed = database.prepare("UPDATE feedback_scores SET sync_status = 'pending', sync_error = ?, updated_at = ? WHERE id = ?");

function stableUuid(value) {
  const hash = crypto.createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function safeMetadata(raw) {
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

function publicFeedback(row) {
  return {
    id: row.id,
    session_id: row.session_id,
    request_id: row.request_id,
    trace_id: row.trace_id,
    name: row.score_name,
    value: row.score_value,
    data_type: row.data_type,
    comment: row.comment,
    metadata: safeMetadata(row.metadata_json),
    sync_status: row.sync_status,
    sync_error: row.sync_error,
    synced_at: row.synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function saveUserFeedback({ userId, sessionId, requestId, traceId, value, comment = null, metadata = {} }) {
  if (value !== 0 && value !== 1) throw new AppError("反馈值只能是 0 或 1", { code: "invalid_feedback", status: 400, expose: true });
  const cleanComment = comment === null ? null : String(comment).trim().slice(0, 1000) || null;
  const now = new Date().toISOString();
  const name = "user-feedback";
  const id = stableUuid(`${userId}\u0000${requestId}\u0000${name}`);
  upsertFeedback.run(
    id,
    String(userId),
    String(sessionId),
    String(requestId),
    String(traceId),
    name,
    value,
    "BOOLEAN",
    cleanComment,
    JSON.stringify(metadata),
    now,
    now
  );
  return publicFeedback(feedbackById.get(id, String(userId)));
}

export function feedbackForRequest({ userId, requestId }) {
  return feedbackByRequest.all(String(requestId), String(userId)).map(publicFeedback);
}

export function markFeedbackSynced({ id, userId }) {
  const now = new Date().toISOString();
  markSynced.run(now, now, id);
  return publicFeedback(feedbackById.get(id, String(userId)));
}

export function markFeedbackExportFailed({ id, userId, error }) {
  markFailed.run(String(error?.message || error || "unknown").slice(0, 500), new Date().toISOString(), id);
  return publicFeedback(feedbackById.get(id, String(userId)));
}

export function feedbackStoreStatus() {
  const counts = database.prepare("SELECT sync_status, COUNT(*) AS count FROM feedback_scores GROUP BY sync_status").all();
  return { configured: true, provider: "sqlite", score_name: "user-feedback", counts: Object.fromEntries(counts.map(row => [row.sync_status, Number(row.count)])) };
}
