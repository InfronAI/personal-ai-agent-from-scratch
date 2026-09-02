import crypto from "node:crypto";

import { config } from "./config.mjs";
import { database } from "./database.mjs";
import { AppError } from "./errors.mjs";
import {
  containsSensitiveMemory,
  isMemoryQuestion,
  memoryPolicyStatus,
  memoryWriteDecision as decideMemoryWrite,
  normalizeMemoryText
} from "./memory-policy.mjs";

const upsertMemory = database.prepare(`
  INSERT INTO memory_entries (
    id, user_id, session_id, trace_id, kind, user_message, assistant_response,
    metadata_json, created_at, updated_at, active, content, memory_key, status,
    importance, confidence, expires_at, superseded_by, policy_version
  ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 1, ?, ?, 'active', ?, ?, ?, NULL, ?)
  ON CONFLICT(id) DO UPDATE SET
    session_id = excluded.session_id,
    trace_id = excluded.trace_id,
    kind = excluded.kind,
    user_message = excluded.user_message,
    assistant_response = '',
    metadata_json = excluded.metadata_json,
    updated_at = excluded.updated_at,
    active = 1,
    content = excluded.content,
    memory_key = excluded.memory_key,
    status = 'active',
    importance = excluded.importance,
    confidence = excluded.confidence,
    expires_at = excluded.expires_at,
    superseded_by = NULL,
    policy_version = excluded.policy_version
`);
const supersedeMemoryKey = database.prepare(`
  UPDATE memory_entries
  SET active = 0, status = 'superseded', superseded_by = ?, updated_at = ?
  WHERE user_id = ? AND memory_key = ? AND id <> ? AND active = 1 AND status = 'active'
`);
const selectCandidateHistory = database.prepare(`
  SELECT id, session_id, trace_id, kind, content, memory_key, metadata_json,
         created_at, updated_at, last_accessed_at, access_count,
         importance, confidence, expires_at, policy_version, active, status,
         superseded_by
  FROM memory_entries
  WHERE user_id = ? AND status IN ('active', 'superseded')
    AND (
      (expires_at IS NOT NULL AND expires_at > ?)
      OR (expires_at IS NULL AND updated_at >= ?)
    )
  ORDER BY updated_at DESC
  LIMIT ?
`);
const markAccessed = database.prepare(`
  UPDATE memory_entries
  SET access_count = access_count + 1, last_accessed_at = ?
  WHERE id = ? AND user_id = ? AND active = 1
`);
const memorySetting = database.prepare("SELECT enabled, updated_at FROM memory_settings WHERE user_id = ?");
const upsertMemorySetting = database.prepare(`
  INSERT INTO memory_settings(user_id, enabled, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
`);
const deactivateMemory = database.prepare(`
  UPDATE memory_entries
  SET active = 0, status = 'deleted', updated_at = ?
  WHERE id = ? AND user_id = ? AND active = 1
`);
const deactivateMemories = database.prepare(`
  UPDATE memory_entries
  SET active = 0, status = 'deleted', updated_at = ?
  WHERE user_id = ? AND id = ? AND active = 1
`);
const deactivateAllMemories = database.prepare(`
  UPDATE memory_entries
  SET active = 0, status = 'deleted', updated_at = ?
  WHERE user_id = ? AND active = 1 AND status = 'active'
`);
const deactivateExpiredMemories = database.prepare(`
  UPDATE memory_entries
  SET active = 0, status = 'expired', updated_at = ?
  WHERE active = 1 AND status = 'active'
    AND (
      (expires_at IS NOT NULL AND expires_at <= ?)
      OR (expires_at IS NULL AND updated_at < ?)
    )
`);
const managedMemory = database.prepare(`
  SELECT * FROM memory_entries
  WHERE id = ? AND user_id = ? AND active = 1 AND status = 'active'
  LIMIT 1
`);
const updateManagedMemory = database.prepare(`
  UPDATE memory_entries
  SET kind = ?, user_message = ?, content = ?, memory_key = ?, metadata_json = ?,
      importance = ?, confidence = 1, expires_at = ?, policy_version = ?, updated_at = ?
  WHERE id = ? AND user_id = ? AND active = 1 AND status = 'active'
`);

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from", "how",
  "i", "in", "is", "it", "me", "my", "of", "on", "or", "that", "the", "this", "to",
  "was", "were", "what", "when", "where", "which", "who", "with", "you", "your"
]);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MANUAL_POLICY_VERSION = "copilot-memory-manual.v1";
const MANAGED_KINDS = new Set(["preference", "profile", "constraint", "explicit_memory"]);

function cleanIdentifier(value, fallback = "") {
  return String(value || fallback).trim().slice(0, 200) || fallback;
}

function scopedUser(value) {
  const userId = cleanIdentifier(value);
  if (!userId) throw new AppError("需要已认证用户", { code: "unauthorized", status: 401, expose: true });
  return userId;
}

function validNow(value = new Date()) {
  const result = value instanceof Date ? value : new Date(value);
  return Number.isNaN(result.getTime()) ? new Date() : result;
}

function legacyCutoff(now) {
  return new Date(now.getTime() - (config.database.memoryRetentionDays * 86_400_000)).toISOString();
}

function safeMetadata(raw) {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function managedMemoryInput({ content, kind = "explicit_memory", expiresInDays = null }) {
  const normalized = normalizeMemoryText(content).slice(0, 1200);
  if (!normalized) throw new AppError("记忆内容不能为空", { code: "invalid_memory_content", status: 400, expose: true });
  if (containsSensitiveMemory(normalized)) {
    throw new AppError("长期记忆不能保存凭证或敏感信息", { code: "sensitive_memory", status: 400, expose: true });
  }
  const normalizedKind = String(kind || "explicit_memory").trim();
  if (!MANAGED_KINDS.has(normalizedKind)) {
    throw new AppError("记忆类型无效", { code: "invalid_memory_kind", status: 400, expose: true });
  }
  const fallbackDays = normalizedKind === "profile"
    ? config.database.memoryProfileRetentionDays
    : config.database.memoryRetentionDays;
  const ttlDays = expiresInDays === null || expiresInDays === undefined || expiresInDays === ""
    ? fallbackDays
    : Number(expiresInDays);
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 3650) {
    throw new AppError("记忆有效期必须是 1 到 3650 天的整数", { code: "invalid_memory_ttl", status: 400, expose: true });
  }
  return { content: normalized, kind: normalizedKind, ttlDays };
}

function tokens(value) {
  const result = new Set();
  for (const token of normalizeMemoryText(value).toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) || []) {
    if (CJK.test(token)) {
      const characters = [...token];
      for (const character of characters) result.add(character);
      for (let index = 0; index < characters.length - 1; index += 1) {
        result.add(`${characters[index]}${characters[index + 1]}`);
      }
      continue;
    }
    if (token.length > 1 && !STOP_WORDS.has(token)) {
      result.add(token);
      if (token.length > 4 && token.endsWith("ies")) result.add(`${token.slice(0, -3)}y`);
      else if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) result.add(token.slice(0, -1));
    }
  }
  return result;
}

function daysSince(isoDate, now = Date.now()) {
  const timestamp = Date.parse(isoDate);
  if (!Number.isFinite(timestamp)) return config.database.memoryRecencyHalfLifeDays * 4;
  return Math.max(0, (now - timestamp) / 86_400_000);
}

function queryFacets(query) {
  const value = normalizeMemoryText(query);
  if (/(?:我叫什么(?:名字)?|我的名字(?:是|叫)?什么|用户(?:的)?(?:姓名|名字)|姓名|名字)|\b(?:what(?:'s| is) my name|user(?:'s)? name)\b/iu.test(value)) {
    return [{ id: "identity-name", memoryKeys: new Set(["profile:identity-name"]), kinds: new Set(["profile"]) }];
  }
  if (/(?:用户身份|身份资料)|\buser identity\b/iu.test(value)) {
    return [{ id: "identity-profile", memoryKeys: new Set(), kinds: new Set(["profile"]) }];
  }
  if (/(?:你(?:知道|记得|了解)我|关于我|我的资料|用户(?:资料|画像))|\b(?:do (?:you|u) know me|what do you know about me|user profile)\b/iu.test(value)) {
    return [{ id: "profile-overview", memoryKeys: new Set(), kinds: new Set(MANAGED_KINDS) }];
  }
  const facets = [];
  if (/(?:回答|回复).*(?:语言|中文|英文)|(?:语言|中文|英文).*(?:偏好|回答|回复)|\b(?:response|answer) language\b/iu.test(value)) {
    facets.push({ id: "response-language", memoryKeys: new Set(["preference:response-language", "constraint:response-language"]), kinds: new Set(["preference", "constraint"]) });
  }
  if (/(?:回答|回复|报告).*(?:风格|格式|简洁|详细)|(?:风格|格式).*(?:偏好|回答|回复|报告)|\b(?:response|answer|report) style\b/iu.test(value)) {
    facets.push({ id: "response-style", memoryKeys: new Set(["preference:response-style", "constraint:response-style"]), kinds: new Set(["preference", "constraint"]) });
  }
  return facets;
}

function broadMemoryQuery(query) {
  return /\b(remember|memory|memories|know (?:about )?me|previously|before|user (?:identity|profile))\b|记得|记忆|了解我|知道我|关于我|之前|以前|过往|历史|偏好|用户资料/iu.test(normalizeMemoryText(query));
}

function facetMatch(row, facets) {
  let score = 0;
  let reason = null;
  for (const facet of facets) {
    if (facet.memoryKeys.has(row.memory_key)) {
      if (score < 1) {
        score = 1;
        reason = `memory_key:${facet.id}`;
      }
    } else if (facet.kinds.has(row.kind) && score < 0.68) {
      score = 0.68;
      reason = `memory_kind:${facet.id}`;
    }
  }
  return { score, reason };
}

function scoreCandidates(rows, query, sessionId, now = Date.now()) {
  const queryTerms = [...tokens(query)];
  const normalizedQuery = normalizeMemoryText(query).toLocaleLowerCase("und");
  const broad = broadMemoryQuery(query);
  const facets = queryFacets(query);
  const documents = rows.map(row => ({
    row,
    normalized: normalizeMemoryText(row.content).toLocaleLowerCase("und"),
    terms: tokens(row.content)
  }));
  const frequencies = new Map(queryTerms.map(term => [
    term,
    documents.filter(document => document.terms.has(term)).length
  ]));
  const denominator = queryTerms.reduce((total, term) => (
    total + Math.log((documents.length + 1) / ((frequencies.get(term) || 0) + 1)) + 1
  ), 0) || 1;

  return documents.map(document => {
    const matchedTerms = queryTerms.filter(term => document.terms.has(term));
    const matchedWeight = matchedTerms.reduce((total, term) => (
      total + Math.log((documents.length + 1) / ((frequencies.get(term) || 0) + 1)) + 1
    ), 0);
    const lexical = matchedWeight / denominator;
    const phrase = normalizedQuery.length >= 4 && document.normalized.includes(normalizedQuery) ? 1 : 0;
    const recency = Math.exp(
      -Math.log(2) * daysSince(document.row.updated_at, now) / config.database.memoryRecencyHalfLifeDays
    );
    const sameSession = document.row.session_id === sessionId ? 1 : 0;
    const importance = Math.max(0, Math.min(1, Number(document.row.importance) || 0));
    const confidence = Math.max(0, Math.min(1, Number(document.row.confidence) || 0));
    const facet = facetMatch(document.row, facets);
    const score = facet.score > 0
      ? (facet.score * 0.58) + (lexical * 0.08) + (phrase * 0.04) + (recency * 0.1) + (importance * 0.12) + (confidence * 0.06) + (sameSession * 0.02)
      : broad
        ? (lexical * 0.4) + (phrase * 0.1) + (recency * 0.2) + (importance * 0.2) + (confidence * 0.07) + (sameSession * 0.03)
        : (lexical * 0.66) + (phrase * 0.12) + (recency * 0.07) + (importance * 0.08) + (confidence * 0.05) + (sameSession * 0.02);
    return { ...document, score, lexical, phrase, matchedTerms, broad, facet };
  }).filter(item => (
    (item.facet.score > 0 || (facets.length === 0 && item.broad) || item.lexical > 0 || item.phrase > 0)
    && item.score >= config.database.memoryMinimumScore
  )).sort((left, right) => (
    right.score - left.score
    || right.row.importance - left.row.importance
    || right.row.updated_at.localeCompare(left.row.updated_at)
  ));
}

function selectWithinBudget(matches, limit) {
  const selected = [];
  const seenKeys = new Set();
  let characters = 0;
  for (const match of matches) {
    if (selected.length >= limit || seenKeys.has(match.row.memory_key)) continue;
    const length = String(match.row.content || "").length;
    if (selected.length && characters + length > config.database.memoryContextBudgetCharacters) continue;
    selected.push(match);
    seenKeys.add(match.row.memory_key);
    characters += length;
  }
  return { selected, characters };
}

function usableRecoveryContent(row) {
  return row
    && !containsSensitiveMemory(row.content)
    && (String(row.policy_version || "").startsWith("copilot-memory-manual.") || !isMemoryQuestion(row.content));
}

function effectiveCandidates(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.memory_key || `unkeyed:${row.id}`;
    const bucket = groups.get(key) || [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const selected = [];
  for (const group of groups.values()) {
    group.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    const active = group.find(row => row.active === 1 && row.status === "active");
    if (!active) continue;
    if (usableRecoveryContent(active)) {
      selected.push({ ...active, recovery: null });
      continue;
    }
    const fallback = group.find(row => row.status === "superseded" && usableRecoveryContent(row));
    if (!fallback) continue;
    selected.push({
      ...fallback,
      id: active.id,
      updated_at: active.updated_at,
      recovery: {
        mode: "invalid-active-fallback",
        active_record_id: active.id,
        source_record_id: fallback.id,
        source_status: fallback.status
      }
    });
  }
  return selected.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

function activeCandidates(userId, now, limit = config.database.memoryCandidateLimit) {
  const historyLimit = Math.min(10_000, Math.max(limit, limit * 4));
  const history = selectCandidateHistory.all(userId, now.toISOString(), legacyCutoff(now), historyLimit);
  return effectiveCandidates(history).slice(0, limit);
}

function forgetByQuery(userId, query, now) {
  if (/^(?:所有|全部|all)\s*(?:长期)?(?:记忆|memories?)?$/iu.test(normalizeMemoryText(query))) {
    return deactivateAllMemories.run(now.toISOString(), userId).changes;
  }
  const candidates = activeCandidates(userId, now);
  const matches = scoreCandidates(candidates, query, "", now.getTime())
    .filter(match => match.facet.score > 0 || match.lexical > 0 || match.phrase > 0)
    .slice(0, 10);
  let deleted = 0;
  for (const match of matches) {
    deleted += deactivateMemories.run(now.toISOString(), userId, match.row.id).changes;
  }
  return deleted;
}

export const memoryWriteDecision = decideMemoryWrite;

export function getMemorySettings(userId) {
  const scopedUserId = scopedUser(userId);
  const row = memorySetting.get(scopedUserId);
  return { enabled: row ? Boolean(row.enabled) : true, updated_at: row?.updated_at || null };
}

export function setMemoryEnabled({ userId, enabled }) {
  const scopedUserId = scopedUser(userId);
  const now = new Date().toISOString();
  upsertMemorySetting.run(scopedUserId, enabled ? 1 : 0, now);
  return { enabled: Boolean(enabled), updated_at: now };
}

export const rememberConversationTurn = database.transaction(({
  userId,
  sessionId,
  traceId = null,
  userMessage,
  assistantResponse: _assistantResponse,
  metadata = {},
  now = new Date()
}) => {
  const scopedUserId = scopedUser(userId);
  const scopedSessionId = cleanIdentifier(sessionId, "unknown-session");
  const timestamp = validNow(now);
  const policy = decideMemoryWrite(userMessage);

  if (policy.action === "forget") {
    const deletedCount = forgetByQuery(scopedUserId, policy.query, timestamp);
    return {
      action: "forget",
      stored: false,
      reason: policy.reason,
      deleted_count: deletedCount,
      policy_version: policy.policyVersion
    };
  }
  if (!getMemorySettings(scopedUserId).enabled) {
    return { action: "skip", stored: false, reason: "memory_disabled", policy_version: policy.policyVersion };
  }
  if (!policy.shouldWrite) {
    return { action: "skip", stored: false, reason: policy.reason, policy_version: policy.policyVersion };
  }

  const createdAt = timestamp.toISOString();
  const expiresAt = new Date(timestamp.getTime() + (policy.ttlDays * 86_400_000)).toISOString();
  const identity = `${scopedUserId}\u0000${policy.kind}\u0000${normalizeMemoryText(policy.content).toLocaleLowerCase("und")}`;
  const id = `mem-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
  const supersededCount = supersedeMemoryKey.run(
    id,
    createdAt,
    scopedUserId,
    policy.memoryKey,
    id
  ).changes;
  const safe = {
    ...metadata,
    memory_policy: {
      version: policy.policyVersion,
      reason: policy.reason,
      extracted_by: "deterministic",
      source_role: "user"
    }
  };
  upsertMemory.run(
    id,
    scopedUserId,
    scopedSessionId,
    traceId ? cleanIdentifier(traceId) : null,
    policy.kind,
    policy.content,
    JSON.stringify(safe),
    createdAt,
    createdAt,
    policy.content,
    policy.memoryKey,
    policy.importance,
    policy.confidence,
    expiresAt,
    policy.policyVersion
  );
  return {
    action: "upsert",
    stored: true,
    memory_id: id,
    memory_key: policy.memoryKey,
    kind: policy.kind,
    content: policy.content,
    superseded_count: supersededCount,
    created_at: createdAt,
    expires_at: expiresAt,
    policy_version: policy.policyVersion
  };
});

export function loadMemory({ userId, sessionId, query, limit = 5, now = new Date() }) {
  const scopedUserId = scopedUser(userId);
  const scopedSessionId = cleanIdentifier(sessionId, "unknown-session");
  const cleanQuery = normalizeMemoryText(query).slice(0, 2000);
  if (!getMemorySettings(scopedUserId).enabled) {
    return {
      status: "success",
      query: cleanQuery,
      memories: [],
      returned_count: 0,
      retrieval: {
        scope: "current_user",
        strategy: "disabled",
        candidate_count: 0,
        context_characters: 0,
        limit: 0
      }
    };
  }
  if (!cleanQuery) {
    return { status: "error", error: "load_memory requires a non-empty query", memories: [], returned_count: 0 };
  }

  const timestamp = validNow(now);
  const requestedLimit = Math.min(10, Math.max(1, Number(limit) || config.database.memoryResultLimit));
  const candidates = activeCandidates(scopedUserId, timestamp);
  const ranked = scoreCandidates(candidates, cleanQuery, scopedSessionId, timestamp.getTime());
  const { selected, characters } = selectWithinBudget(ranked, requestedLimit);
  const accessedAt = timestamp.toISOString();
  for (const match of selected) markAccessed.run(accessedAt, match.row.id, scopedUserId);
  const memories = selected.map(match => ({
    memory_id: match.row.id,
    memory_key: match.row.memory_key,
    kind: match.row.kind,
    content: match.row.content,
    importance: Number(match.row.importance),
    confidence: Number(match.row.confidence),
    expires_at: match.row.expires_at,
    relevance_score: Number(match.score.toFixed(4)),
    match_reason: match.facet.reason || (match.matchedTerms.length ? "matched_query_terms" : "broad_memory_recall"),
    matched_terms: match.matchedTerms,
    recovered: Boolean(match.row.recovery),
    source: {
      role: "user",
      session_id: match.row.session_id,
      trace_id: match.row.trace_id,
      created_at: match.row.created_at,
      updated_at: match.row.updated_at
    },
    metadata: {
      ...safeMetadata(match.row.metadata_json),
      ...(match.row.recovery ? { lifecycle_recovery: match.row.recovery } : {})
    }
  }));
  return {
    status: "success",
    query: cleanQuery,
    memories,
    returned_count: memories.length,
    retrieval: {
      scope: "current_user",
      strategy: "hybrid_lexical_faceted_lifecycle_v3",
      candidate_count: candidates.length,
      ranked_count: ranked.length,
      recovered_count: memories.filter(memory => memory.recovered).length,
      context_characters: characters,
      context_budget_characters: config.database.memoryContextBudgetCharacters,
      minimum_score: config.database.memoryMinimumScore,
      limit: requestedLimit
    }
  };
}

export function listMemories(userId, limit = 100, now = new Date()) {
  const scopedUserId = scopedUser(userId);
  const timestamp = validNow(now);
  const requestedLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  return activeCandidates(scopedUserId, timestamp, requestedLimit).map(row => ({
    memory_id: row.id,
    memory_key: row.memory_key,
    kind: row.kind,
    content: row.content,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    expires_at: row.expires_at,
    source: { role: "user", session_id: row.session_id, trace_id: row.trace_id },
    metadata: {
      ...safeMetadata(row.metadata_json),
      ...(row.recovery ? { lifecycle_recovery: row.recovery } : {})
    },
    recovered: Boolean(row.recovery),
    access_count: row.access_count,
    last_accessed_at: row.last_accessed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    policy_version: row.policy_version
  }));
}

export function createMemory({ userId, content, kind, expiresInDays }) {
  const scopedUserId = scopedUser(userId);
  const input = managedMemoryInput({ content, kind, expiresInDays });
  const id = `mem-${crypto.randomBytes(12).toString("hex")}`;
  const now = new Date();
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + (input.ttlDays * 86_400_000)).toISOString();
  const metadata = {
    memory_policy: {
      version: MANUAL_POLICY_VERSION,
      reason: "manual_user_entry",
      extracted_by: "human",
      source_role: "user"
    }
  };
  upsertMemory.run(
    id,
    scopedUserId,
    "manual-memory",
    null,
    input.kind,
    input.content,
    JSON.stringify(metadata),
    timestamp,
    timestamp,
    input.content,
    `manual:${id}`,
    0.9,
    1,
    expiresAt,
    MANUAL_POLICY_VERSION
  );
  return listMemories(scopedUserId).find(item => item.memory_id === id);
}

export function updateMemory({ userId, memoryId, content, kind, expiresInDays }) {
  const scopedUserId = scopedUser(userId);
  const id = cleanIdentifier(memoryId);
  const existing = managedMemory.get(id, scopedUserId);
  if (!existing) throw new AppError("记忆不存在", { code: "memory_not_found", status: 404, expose: true });
  const remainingDays = existing.expires_at
    ? Math.max(1, Math.ceil((Date.parse(existing.expires_at) - Date.now()) / 86_400_000))
    : null;
  const input = managedMemoryInput({
    content: content ?? existing.content,
    kind: kind ?? existing.kind,
    expiresInDays: expiresInDays ?? remainingDays
  });
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (input.ttlDays * 86_400_000)).toISOString();
  const metadata = {
    ...safeMetadata(existing.metadata_json),
    memory_policy: {
      version: MANUAL_POLICY_VERSION,
      reason: "manual_user_edit",
      extracted_by: "human",
      source_role: "user"
    }
  };
  updateManagedMemory.run(
    input.kind,
    input.content,
    input.content,
    existing.memory_key || `manual:${id}`,
    JSON.stringify(metadata),
    Math.max(0.9, Number(existing.importance) || 0),
    expiresAt,
    MANUAL_POLICY_VERSION,
    timestamp,
    id,
    scopedUserId
  );
  return listMemories(scopedUserId).find(item => item.memory_id === id);
}

export function deleteMemory({ userId, memoryId }) {
  const scopedUserId = scopedUser(userId);
  const id = cleanIdentifier(memoryId);
  const changes = deactivateMemory.run(new Date().toISOString(), id, scopedUserId).changes;
  if (!changes) throw new AppError("记忆不存在", { code: "memory_not_found", status: 404, expose: true });
  return { deleted: true, memory_id: id };
}

export function cleanupExpiredMemories(now = new Date()) {
  const timestamp = validNow(now);
  const cutoff = legacyCutoff(timestamp);
  return {
    deactivated: deactivateExpiredMemories.run(timestamp.toISOString(), timestamp.toISOString(), cutoff).changes,
    cutoff
  };
}

export function memoryStoreStatus() {
  return {
    configured: true,
    provider: "sqlite",
    ...memoryPolicyStatus(),
    retrieval_strategy: "hybrid_lexical_faceted_lifecycle_v3",
    candidate_limit: config.database.memoryCandidateLimit,
    result_limit: config.database.memoryResultLimit,
    context_budget_characters: config.database.memoryContextBudgetCharacters,
    minimum_score: config.database.memoryMinimumScore
  };
}
