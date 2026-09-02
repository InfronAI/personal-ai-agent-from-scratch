import crypto from "node:crypto";

import { database } from "./database.mjs";
import { AppError } from "./errors.mjs";
import {
  captureEvaluationEvidence,
  EVALUATION_EVIDENCE_SCHEMA_VERSION,
  EVALUATION_EVIDENCE_SCOPE,
  evaluationEvidenceForExport,
  evaluationEvidenceSummaryForTurn
} from "./evaluation-evidence-store.mjs";

const DATASET_NAME = "copilot-feedback-golden";
const DATASET_VERSION = "copilot-feedback-golden.v1";
const REVIEW_QUEUE_STATUS = "candidate";
const REJECTED_DISPOSITION = "audit-only";

const turnByOwner = database.prepare(`
  SELECT request_id, session_id, user_id, prompt, answer, trace_id, result_json, created_at
  FROM chat_turns WHERE request_id = ? AND user_id = ? LIMIT 1
`);
const turnsBySessionOwner = database.prepare(`
  SELECT request_id, prompt, answer, created_at
  FROM chat_turns WHERE session_id = ? AND user_id = ?
  ORDER BY created_at, request_id
`);
const candidateById = database.prepare("SELECT * FROM eval_feedback_candidates WHERE id = ? AND user_id = ? LIMIT 1");
const candidatesByUser = database.prepare(`
  SELECT * FROM eval_feedback_candidates
  WHERE user_id = ? AND (? IS NULL OR review_status = ?)
  ORDER BY updated_at DESC LIMIT ?
`);
const goldenByUser = database.prepare(`
  SELECT * FROM eval_golden_items
  WHERE user_id = ? AND (? IS NULL OR active = ?)
  ORDER BY updated_at DESC LIMIT ?
`);
const activeGoldenAll = database.prepare(`
  SELECT * FROM eval_golden_items WHERE active = 1
  ORDER BY updated_at, id
`);
const goldenByCandidate = database.prepare("SELECT * FROM eval_golden_items WHERE candidate_id = ? AND user_id = ? LIMIT 1");
const goldenById = database.prepare("SELECT * FROM eval_golden_items WHERE id = ? AND user_id = ? LIMIT 1");

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanFailureCodes(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new AppError("failureCodes 必须是长度不超过 20 的数组", { code: "invalid_failure_codes", status: 400, expose: true });
  }
  const codes = [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))];
  if (codes.some(code => !/^[a-z][a-z0-9_]{2,63}$/u.test(code))) {
    throw new AppError("failureCodes 包含无效值", { code: "invalid_failure_codes", status: 400, expose: true });
  }
  return codes;
}

function publicCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    feedback_id: row.feedback_id,
    user_id: row.user_id,
    session_id: row.session_id,
    request_id: row.request_id,
    trace_id: row.trace_id,
    prompt: row.prompt,
    input: parseJson(row.input_json, { messages: [{ role: "user", content: row.prompt }] }),
    actual_output: row.actual_output,
    score_value: row.score_value,
    comment: row.comment,
    routing: parseJson(row.routing_json, {}),
    evaluation_evidence: evaluationEvidenceSummaryForTurn({ userId: row.user_id, requestId: row.request_id }),
    review_status: row.review_status,
    failure_codes: parseJson(row.failure_codes_json, []),
    expected_output: parseJson(row.expected_output_json, null),
    expected_route: parseJson(row.expected_route_json, null),
    reviewer: row.reviewer,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function reproducibleInput(turn) {
  const messages = [];
  for (const item of turnsBySessionOwner.all(turn.session_id, turn.user_id)) {
    messages.push({ role: "user", content: item.prompt });
    if (item.request_id === turn.request_id) break;
    messages.push({ role: "assistant", content: item.answer });
  }
  const bounded = messages.slice(-25);
  if (bounded[0]?.role === "assistant") bounded.shift();
  return { messages: bounded.length ? bounded : [{ role: "user", content: turn.prompt }] };
}

function publicGolden(row) {
  if (!row) return null;
  const item = parseJson(row.item_json, {});
  return {
    ...item,
    golden_id: row.id,
    candidate_id: row.candidate_id,
    item_version: row.item_version,
    active: Boolean(row.active),
    lifecycle_status: row.active ? "active" : "archived",
    updated_at: row.updated_at
  };
}

function taskMetadata(result) {
  const intent = result?.routing?.intent || result?.intent || {};
  return {
    taskType: intent.taskType || "user_feedback_case",
    risk: ["low", "medium", "high"].includes(intent.risk?.level) ? intent.risk.level : "low"
  };
}

const captureTransaction = database.transaction(({ userId, feedbackId, requestId, value, comment }) => {
  if (value !== 0 && value !== 1) throw new AppError("反馈值只能是 0 或 1", { code: "invalid_feedback", status: 400, expose: true });
  const turn = turnByOwner.get(String(requestId), String(userId));
  if (!turn) throw new AppError("对话轮次不存在", { code: "turn_not_found", status: 404, expose: true });
  const result = parseJson(turn.result_json, {});
  const candidateId = stableId("gfc", `${userId}\u0000${feedbackId}`);
  const now = new Date().toISOString();
  captureEvaluationEvidence({ userId, requestId: turn.request_id, capturedAt: now });
  database.prepare(`
    INSERT INTO eval_feedback_candidates (
      id, feedback_id, user_id, session_id, request_id, trace_id, prompt, actual_output,
      score_value, comment, routing_json, input_json, review_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
    ON CONFLICT(feedback_id) DO UPDATE SET
      prompt = excluded.prompt,
      actual_output = excluded.actual_output,
      score_value = excluded.score_value,
      comment = excluded.comment,
      routing_json = excluded.routing_json,
      input_json = excluded.input_json,
      review_status = 'candidate',
      failure_codes_json = '[]',
      expected_output_json = NULL,
      expected_route_json = NULL,
      reviewer = NULL,
      reviewed_at = NULL,
      updated_at = excluded.updated_at
  `).run(
    candidateId,
    String(feedbackId),
    String(userId),
    turn.session_id,
    turn.request_id,
    turn.trace_id,
    turn.prompt,
    turn.answer,
    value,
    comment === null || comment === undefined ? null : String(comment).trim().slice(0, 1000) || null,
    JSON.stringify(result.routing || result.intent || {}),
    JSON.stringify(reproducibleInput(turn)),
    now,
    now
  );
  database.prepare("UPDATE eval_golden_items SET active = 0, updated_at = ? WHERE candidate_id = ? AND user_id = ?")
    .run(now, candidateId, String(userId));
  return publicCandidate(candidateById.get(candidateId, String(userId)));
});

export function captureFeedbackCandidate(input) {
  return captureTransaction(input);
}

export function listFeedbackCandidates({ userId, status = REVIEW_QUEUE_STATUS, limit = 100 }) {
  const normalizedStatus = status === "all" ? null : String(status || REVIEW_QUEUE_STATUS);
  if (normalizedStatus && !["candidate", "approved", "rejected"].includes(normalizedStatus)) {
    throw new AppError("无效的审核状态", { code: "invalid_review_status", status: 400, expose: true });
  }
  return candidatesByUser
    .all(String(userId), normalizedStatus, normalizedStatus, Math.min(500, Math.max(1, Number(limit) || 100)))
    .map(publicCandidate);
}

const reviewTransaction = database.transaction(({ userId, candidateId, decision, reviewer, expectedOutput, expectedRoute, failureCodes }) => {
  if (!["approve", "reject"].includes(decision)) {
    throw new AppError("decision 必须是 approve 或 reject", { code: "invalid_review_decision", status: 400, expose: true });
  }
  const row = candidateById.get(String(candidateId), String(userId));
  if (!row) throw new AppError("反馈候选不存在", { code: "feedback_candidate_not_found", status: 404, expose: true });
  const candidate = publicCandidate(row);
  const codes = cleanFailureCodes(failureCodes);
  const normalizedExpectedOutput = typeof expectedOutput === "string"
    ? expectedOutput.trim()
    : expectedOutput && typeof expectedOutput === "object" ? expectedOutput : null;
  if (decision === "approve" && candidate.score_value === 0 && !normalizedExpectedOutput && codes.length === 0) {
    throw new AppError("点踩样本必须补充期望输出或 Failure Code 后才能进入 Golden Set", {
      code: "golden_expected_behavior_required", status: 400, expose: true
    });
  }
  const now = new Date().toISOString();
  const evidence = captureEvaluationEvidence({ userId, requestId: row.request_id, capturedAt: now });
  const reviewerName = String(reviewer || "human-reviewer").trim().slice(0, 120);
  const status = decision === "approve" ? "approved" : "rejected";
  database.prepare(`
    UPDATE eval_feedback_candidates
    SET review_status = ?, failure_codes_json = ?, expected_output_json = ?, expected_route_json = ?,
        reviewer = ?, reviewed_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    status,
    JSON.stringify(codes),
    normalizedExpectedOutput === null ? null : JSON.stringify(normalizedExpectedOutput),
    expectedRoute && typeof expectedRoute === "object" ? JSON.stringify(expectedRoute) : null,
    reviewerName,
    now,
    now,
    row.id,
    String(userId)
  );
  if (decision === "reject") {
    database.prepare("UPDATE eval_golden_items SET active = 0, updated_at = ? WHERE candidate_id = ? AND user_id = ?")
      .run(now, row.id, String(userId));
    return {
      candidate: publicCandidate(candidateById.get(row.id, String(userId))),
      removed_from_review_queue: true,
      golden_item: null
    };
  }

  const result = parseJson(turnByOwner.get(row.request_id, String(userId))?.result_json, {});
  const meta = taskMetadata(result);
  const referenceAnswer = typeof normalizedExpectedOutput === "string"
    ? normalizedExpectedOutput
    : normalizedExpectedOutput?.reference_answer || (candidate.score_value === 1 ? candidate.actual_output : null);
  const route = expectedRoute && typeof expectedRoute === "object" ? expectedRoute : null;
  const item = {
    id: stableId("feedback", row.id),
    suite: "feedback-golden",
    input: candidate.input,
    expected: {
      response: referenceAnswer ? { reference_answer: referenceAnswer } : {},
      ...(route ? { route } : {}),
      feedback: { value: candidate.score_value, failure_codes: codes }
    },
    metadata: {
      dataset_version: DATASET_VERSION,
      task_type: meta.taskType,
      risk: meta.risk,
      source: "user-feedback",
      label_status: "human-reviewed",
      live_eligible: true,
      tags: [candidate.score_value === 1 ? "thumbs-up" : "thumbs-down", ...codes],
      source_trace_id: candidate.trace_id,
      source_request_id: candidate.request_id,
      source_session_id: candidate.session_id,
      evidence_snapshot_id: evidence.id,
      evidence_schema_version: evidence.schema_version,
      evidence_content_hash: evidence.content_hash,
      evidence_scope: evidence.scope,
      reviewed_by: reviewerName,
      reviewed_at: now
    }
  };
  const goldenId = stableId("gold", row.id);
  const existing = goldenByCandidate.get(row.id, String(userId));
  database.prepare(`
    INSERT INTO eval_golden_items (
      id, candidate_id, user_id, dataset_name, item_version, item_json, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(candidate_id) DO UPDATE SET
      item_version = eval_golden_items.item_version + 1,
      item_json = excluded.item_json,
      active = 1,
      updated_at = excluded.updated_at
  `).run(goldenId, row.id, String(userId), DATASET_NAME, existing ? existing.item_version + 1 : 1, JSON.stringify(item), now, now);
  return {
    candidate: publicCandidate(candidateById.get(row.id, String(userId))),
    golden_item: publicGolden(goldenByCandidate.get(row.id, String(userId)))
  };
});

export function reviewFeedbackCandidate(input) {
  return reviewTransaction(input);
}

export function listGoldenSetItems({ userId, status = "active", limit = 500 }) {
  if (!["active", "archived", "all"].includes(status)) {
    throw new AppError("无效的 Golden Set 生命周期状态", { code: "invalid_golden_status", status: 400, expose: true });
  }
  const active = status === "all" ? null : status === "active" ? 1 : 0;
  return goldenByUser
    .all(String(userId), active, active, Math.min(2000, Math.max(1, Number(limit) || 500)))
    .map(publicGolden);
}

export function updateGoldenSetItemLifecycle({ userId, goldenId, action }) {
  if (!["archive", "restore"].includes(action)) {
    throw new AppError("action 必须是 archive 或 restore", { code: "invalid_golden_action", status: 400, expose: true });
  }
  const row = goldenById.get(String(goldenId), String(userId));
  if (!row) throw new AppError("Golden Set 数据项不存在", { code: "golden_item_not_found", status: 404, expose: true });
  const active = action === "restore" ? 1 : 0;
  database.prepare("UPDATE eval_golden_items SET active = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(active, new Date().toISOString(), row.id, String(userId));
  return publicGolden(goldenById.get(row.id, String(userId)));
}

export function feedbackDatasetSummary({ userId }) {
  const golden = database.prepare(`
    SELECT active, COUNT(*) AS count FROM eval_golden_items
    WHERE user_id = ? GROUP BY active
  `).all(String(userId));
  const reviews = database.prepare(`
    SELECT review_status, COUNT(*) AS count FROM eval_feedback_candidates
    WHERE user_id = ? GROUP BY review_status
  `).all(String(userId));
  const goldenCounts = Object.fromEntries(golden.map(row => [row.active ? "active" : "archived", Number(row.count)]));
  const reviewCounts = Object.fromEntries(reviews.map(row => [row.review_status, Number(row.count)]));
  return {
    active: goldenCounts.active || 0,
    archived: goldenCounts.archived || 0,
    candidates: reviewCounts.candidate || 0,
    approved: reviewCounts.approved || 0,
    rejected: reviewCounts.rejected || 0
  };
}

export function exportableGoldenSetItems() {
  return activeGoldenAll.all().map(row => {
    const item = publicGolden(row);
    const copy = structuredClone(item);
    const evidence = evaluationEvidenceForExport(copy.metadata?.evidence_snapshot_id) || captureEvaluationEvidence({
      userId: row.user_id,
      requestId: copy.metadata?.source_request_id,
      capturedAt: copy.metadata?.reviewed_at || row.updated_at
    });
    copy.metadata.evidence_snapshot_id = evidence.id;
    copy.metadata.evidence_schema_version = evidence.schema_version;
    copy.metadata.evidence_content_hash = evidence.content_hash;
    copy.metadata.evidence_scope = evidence.scope;
    copy.evidence = evidence.snapshot;
    delete copy.golden_id;
    delete copy.candidate_id;
    delete copy.item_version;
    delete copy.active;
    delete copy.updated_at;
    return copy;
  });
}

export function goldenSetStatus() {
  const candidates = database.prepare("SELECT review_status, COUNT(*) AS count FROM eval_feedback_candidates GROUP BY review_status").all();
  const golden = database.prepare("SELECT COUNT(*) AS count FROM eval_golden_items WHERE active = 1").get();
  const evidence = database.prepare("SELECT COUNT(*) AS count FROM eval_evidence_snapshots").get();
  const reviewsByStatus = Object.fromEntries(candidates.map(row => [row.review_status, Number(row.count)]));
  return {
    configured: true,
    provider: "sqlite",
    dataset_name: DATASET_NAME,
    dataset_version: DATASET_VERSION,
    review_policy: {
      queue_status: REVIEW_QUEUE_STATUS,
      rejected_disposition: REJECTED_DISPOSITION
    },
    evidence_policy: {
      schema_version: EVALUATION_EVIDENCE_SCHEMA_VERSION,
      scope: EVALUATION_EVIDENCE_SCOPE,
      feedback_subject: "turn",
      trace_capture: "complete-local-runtime",
      session_boundary: "through-evaluated-turn",
      excludes_future_turns: true,
      golden_export: "self-contained"
    },
    evidence_snapshots: Number(evidence?.count || 0),
    pending_candidates: reviewsByStatus[REVIEW_QUEUE_STATUS] || 0,
    reviews_by_status: reviewsByStatus,
    active_golden_items: Number(golden?.count || 0)
  };
}
