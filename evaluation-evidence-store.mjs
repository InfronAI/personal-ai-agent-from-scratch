import crypto from "node:crypto";

import { database } from "./database.mjs";
import { AppError } from "./errors.mjs";

export const EVALUATION_EVIDENCE_SCHEMA_VERSION = "copilot-eval-evidence.v1";
export const EVALUATION_EVIDENCE_SCOPE = "target-trace+session-prefix";

const turnByOwner = database.prepare(`
  SELECT t.request_id, t.session_id, t.user_id, t.prompt, t.answer, t.trace_id, t.result_json, t.created_at,
         s.title AS session_title
  FROM chat_turns t
  JOIN chat_sessions s ON s.id = t.session_id AND s.user_id = t.user_id
  WHERE t.request_id = ? AND t.user_id = ? LIMIT 1
`);
const turnsBySessionOwner = database.prepare(`
  SELECT request_id, session_id, prompt, answer, trace_id, result_json, created_at
  FROM chat_turns WHERE session_id = ? AND user_id = ?
  ORDER BY created_at, request_id
`);
const evidenceByTurn = database.prepare(`
  SELECT * FROM eval_evidence_snapshots WHERE user_id = ? AND request_id = ? LIMIT 1
`);
const evidenceById = database.prepare("SELECT * FROM eval_evidence_snapshots WHERE id = ? LIMIT 1");
const evidenceByCandidateOwner = database.prepare(`
  SELECT e.* FROM eval_feedback_candidates c
  JOIN eval_evidence_snapshots e ON e.user_id = c.user_id AND e.request_id = c.request_id
  WHERE c.id = ? AND c.user_id = ? LIMIT 1
`);
const insertEvidence = database.prepare(`
  INSERT OR IGNORE INTO eval_evidence_snapshots (
    id, user_id, session_id, request_id, trace_id, schema_version, content_hash, snapshot_json, captured_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const candidatesMissingEvidence = database.prepare(`
  SELECT c.user_id, c.request_id, c.created_at
  FROM eval_feedback_candidates c
  LEFT JOIN eval_evidence_snapshots e ON e.user_id = c.user_id AND e.request_id = c.request_id
  WHERE e.id IS NULL
  ORDER BY c.created_at, c.id LIMIT ?
`);
const missingEvidenceCount = database.prepare(`
  SELECT COUNT(*) AS count
  FROM eval_feedback_candidates c
  LEFT JOIN eval_evidence_snapshots e ON e.user_id = c.user_id AND e.request_id = c.request_id
  WHERE e.id IS NULL
`);

const SENSITIVE_KEY = /^(?:authorization|proxy[-_]?authorization|api[-_]?key|apikey|secret(?:[-_]?key)?|password|access[-_]?token|refresh[-_]?token|private[-_]?key|credential)$/iu;
const DATA_URI = /^data:[^;,]+(?:;[^,]*)?;base64,/iu;
const BEARER_VALUE = /^Bearer\s+\S+/iu;
const SECRET_VALUE = /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/gu;

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function stableId(value) {
  return `evd-${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
}

function sanitizeString(value) {
  if (DATA_URI.test(value)) return "[binary data URI omitted from evaluation evidence]";
  if (BEARER_VALUE.test(value)) return "[authorization value redacted]";
  return value.replace(SECRET_VALUE, "[project key redacted]");
}

function sanitizeEvidence(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(item => sanitizeEvidence(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    sanitizeEvidence(childValue, childKey)
  ]));
}

function normalizeTurn(row, turnIndex) {
  const result = sanitizeEvidence(parseJson(row.result_json, {}));
  return {
    turnIndex,
    requestId: row.request_id,
    traceId: row.trace_id || null,
    createdAt: row.created_at,
    input: { role: "user", content: row.prompt },
    output: { role: "assistant", content: row.answer },
    trace: {
      runtime: Array.isArray(result.runtime) ? result.runtime : [],
      result
    }
  };
}

function buildSnapshot({ target, capturedAt }) {
  const rows = [];
  for (const row of turnsBySessionOwner.all(target.session_id, target.user_id)) {
    rows.push(row);
    if (row.request_id === target.request_id) break;
  }
  const targetIndex = rows.findIndex(row => row.request_id === target.request_id);
  if (targetIndex < 0) {
    throw new AppError("无法构建反馈证据快照", { code: "evaluation_evidence_unavailable", status: 409, expose: true });
  }
  const turns = rows.map((row, index) => normalizeTurn(row, index + 1));
  const targetTurn = turns[targetIndex];
  const traceSpanCount = targetTurn.trace.runtime.length;
  const sessionSpanCount = turns.reduce((total, turn) => total + turn.trace.runtime.length, 0);
  const core = {
    schemaVersion: EVALUATION_EVIDENCE_SCHEMA_VERSION,
    scope: EVALUATION_EVIDENCE_SCOPE,
    subject: {
      type: "turn",
      requestId: target.request_id,
      traceId: target.trace_id || null,
      sessionId: target.session_id,
      turnIndex: targetIndex + 1
    },
    trace: structuredClone(targetTurn),
    session: {
      sessionId: target.session_id,
      title: target.session_title,
      boundary: {
        type: "through-evaluated-turn",
        requestId: target.request_id,
        turnIndex: targetIndex + 1,
        excludesFutureTurns: true
      },
      turnCount: turns.length,
      turns
    },
    coverage: {
      targetTraceCaptured: true,
      traceSpanCount,
      sessionTraceCount: turns.filter(turn => Boolean(turn.traceId)).length,
      sessionSpanCount
    },
    provenance: {
      source: "server-authoritative-sqlite",
      traceSource: "chat_turns.result_json",
      sessionBoundary: "through-evaluated-turn",
      binaryPayloadPolicy: "metadata-only",
      secretPolicy: "redacted"
    }
  };
  const contentHash = crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
  return { ...core, capturedAt, contentHash };
}

function publicEvidence(row, { includeSnapshot = false } = {}) {
  if (!row) return null;
  const snapshot = parseJson(row.snapshot_json, {});
  const summary = {
    id: row.id,
    schema_version: row.schema_version,
    scope: snapshot.scope || EVALUATION_EVIDENCE_SCOPE,
    content_hash: row.content_hash,
    captured_at: row.captured_at,
    target_turn_index: snapshot.subject?.turnIndex || null,
    trace_span_count: snapshot.coverage?.traceSpanCount || 0,
    session_turn_count: snapshot.session?.turnCount || 0,
    session_trace_count: snapshot.coverage?.sessionTraceCount || 0,
    session_span_count: snapshot.coverage?.sessionSpanCount || 0,
    excludes_future_turns: snapshot.session?.boundary?.excludesFutureTurns === true
  };
  return includeSnapshot ? { ...summary, snapshot } : summary;
}

export function captureEvaluationEvidence({ userId, requestId, capturedAt = new Date().toISOString() }) {
  const cleanUserId = String(userId || "");
  const cleanRequestId = String(requestId || "");
  const existing = evidenceByTurn.get(cleanUserId, cleanRequestId);
  if (existing) return publicEvidence(existing, { includeSnapshot: true });
  const target = turnByOwner.get(cleanRequestId, cleanUserId);
  if (!target) throw new AppError("对话轮次不存在", { code: "turn_not_found", status: 404, expose: true });
  const snapshot = buildSnapshot({ target, capturedAt });
  const id = stableId(`${cleanUserId}\u0000${cleanRequestId}`);
  insertEvidence.run(
    id,
    cleanUserId,
    target.session_id,
    target.request_id,
    target.trace_id || null,
    EVALUATION_EVIDENCE_SCHEMA_VERSION,
    snapshot.contentHash,
    JSON.stringify(snapshot),
    capturedAt
  );
  return publicEvidence(evidenceByTurn.get(cleanUserId, cleanRequestId), { includeSnapshot: true });
}

export function evaluationEvidenceSummaryForTurn({ userId, requestId }) {
  return publicEvidence(evidenceByTurn.get(String(userId || ""), String(requestId || "")));
}

export function evaluationEvidenceForCandidate({ userId, candidateId }) {
  return publicEvidence(evidenceByCandidateOwner.get(String(candidateId || ""), String(userId || "")), { includeSnapshot: true });
}

export function evaluationEvidenceForExport(evidenceId) {
  return publicEvidence(evidenceById.get(String(evidenceId || "")), { includeSnapshot: true });
}

export function backfillEvaluationEvidenceSnapshots({ limit = 500 } = {}) {
  const rows = candidatesMissingEvidence.all(Math.min(5000, Math.max(1, Number(limit) || 500)));
  let captured = 0;
  const backfill = database.transaction(() => {
    for (const row of rows) {
      captureEvaluationEvidence({ userId: row.user_id, requestId: row.request_id, capturedAt: row.created_at });
      captured += 1;
    }
  });
  backfill();
  return {
    scanned: rows.length,
    captured,
    remaining: Number(missingEvidenceCount.get()?.count || 0)
  };
}
