import crypto from "node:crypto";

import { config } from "./config.mjs";
import { database } from "./database.mjs";
import { AppError } from "./errors.mjs";

const sessionById = database.prepare("SELECT id, user_id, title, created_at, updated_at FROM chat_sessions WHERE id = ?");
const insertSession = database.prepare("INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
const removeSession = database.prepare("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?");
const removeSessionFeedback = database.prepare("DELETE FROM feedback_scores WHERE session_id = ? AND user_id = ?");
const updateSession = database.prepare("UPDATE chat_sessions SET title = CASE WHEN title = 'New conversation' THEN ? ELSE title END, updated_at = ? WHERE id = ? AND user_id = ?");
const turnByRequest = database.prepare("SELECT session_id, result_json FROM chat_turns WHERE request_id = ? AND user_id = ?");
const insertTurn = database.prepare("INSERT INTO chat_turns (request_id, session_id, user_id, prompt, answer, trace_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const traceByUser = database.prepare("SELECT 1 AS owned FROM chat_turns WHERE trace_id = ? AND user_id = ? LIMIT 1");
const turnByOwner = database.prepare(`
  SELECT request_id, session_id, trace_id, prompt, answer, created_at
  FROM chat_turns WHERE request_id = ? AND user_id = ? LIMIT 1
`);
const recentTurns = database.prepare(`
  SELECT prompt, answer FROM chat_turns WHERE session_id = ? AND user_id = ?
  ORDER BY created_at DESC, request_id DESC LIMIT ?
`);
const sessionsByUser = database.prepare(`
  SELECT id, title, created_at, updated_at FROM chat_sessions
  WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
`);
const turnsForSession = database.prepare(`
  SELECT request_id, prompt, answer, trace_id, result_json, created_at
  FROM chat_turns WHERE session_id = ? AND user_id = ?
  ORDER BY created_at, request_id
`);

function cleanSessionId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/.test(id)) {
    throw new AppError("Invalid session id", { code: "invalid_session", status: 400, expose: true });
  }
  return id;
}

function cleanRequestId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/.test(id) ? id : `req_${crypto.randomUUID()}`;
}

export function prepareConversation({ sessionId, requestId, userId }) {
  const id = cleanSessionId(sessionId);
  const stableRequestId = cleanRequestId(requestId);
  const existing = sessionById.get(id);
  if (existing && existing.user_id !== userId) {
    throw new AppError("Session does not belong to the current user", { code: "session_forbidden", status: 403, expose: true });
  }
  const cached = turnByRequest.get(stableRequestId, userId);
  if (cached && cached.session_id !== id) {
    throw new AppError("Request id was already used for another session", { code: "idempotency_conflict", status: 409, expose: true });
  }
  if (!existing) {
    const now = new Date().toISOString();
    insertSession.run(id, userId, "New conversation", now, now);
  }
  const history = recentTurns.all(id, userId, config.database.historyTurns).reverse().flatMap(turn => [
    { role: "user", content: turn.prompt },
    { role: "assistant", content: turn.answer }
  ]);
  return { sessionId: id, requestId: stableRequestId, history, cachedResult: cached ? JSON.parse(cached.result_json) : null };
}

export const saveCompletedTurn = database.transaction(({ requestId, sessionId, userId, prompt, result }) => {
  const now = new Date().toISOString();
  insertTurn.run(requestId, sessionId, userId, prompt, result.answer, result.traceId || null, JSON.stringify(result), now);
  updateSession.run(prompt.slice(0, 80), now, sessionId, userId);
});

export function ownsTrace(traceId, userId) {
  return Boolean(traceByUser.get(traceId, userId));
}

export function ownedTurn(requestId, userId) {
  const row = turnByOwner.get(String(requestId || ""), String(userId || ""));
  return row ? {
    requestId: row.request_id,
    sessionId: row.session_id,
    traceId: row.trace_id,
    prompt: row.prompt,
    answer: row.answer,
    createdAt: row.created_at
  } : null;
}

export function listConversations(userId, limit = 30) {
  return sessionsByUser.all(userId, Math.min(100, Math.max(1, Number(limit) || 30))).map(session => ({
    id: session.id,
    title: session.title,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    turns: turnsForSession.all(session.id, userId).map(turn => ({
      requestId: turn.request_id,
      prompt: turn.prompt,
      answer: turn.answer,
      traceId: turn.trace_id,
      createdAt: turn.created_at,
      result: JSON.parse(turn.result_json)
    }))
  }));
}

export const deleteConversation = database.transaction(({ sessionId, userId }) => {
  const id = cleanSessionId(sessionId);
  const existing = sessionById.get(id);
  if (!existing) throw new AppError("会话不存在", { code: "session_not_found", status: 404, expose: true });
  if (existing.user_id !== userId) {
    throw new AppError("Session does not belong to the current user", { code: "session_forbidden", status: 403, expose: true });
  }
  removeSessionFeedback.run(id, userId);
  const result = removeSession.run(id, userId);
  return { deleted: result.changes === 1, sessionId: id };
});

export function conversationStoreStatus() {
  return { configured: true, provider: "sqlite", server_authoritative_history: true };
}
