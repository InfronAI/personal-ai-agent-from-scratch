import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-memory-test-"));
process.env.COPILOT_MEMORY_DB = join(directory, "memory.sqlite");
const {
  cleanupExpiredMemories,
  deleteMemory,
  getMemorySettings,
  listMemories,
  loadMemory,
  memoryWriteDecision,
  rememberConversationTurn,
  setMemoryEnabled
} = await import(`../memory-store.mjs?test=${Date.now()}`);

after(() => rmSync(directory, { recursive: true, force: true }));

test("load_memory 为当前用户返回有序的结构化长期记忆", () => {
  rememberConversationTurn({
    userId: "user-a",
    sessionId: "session-exercise",
    traceId: "trace-exercise",
    userMessage: "I prefer short exercise plans that I can do after work.",
    assistantResponse: "Use a 10-minute routine three times per week.",
    metadata: { specialist: "teaching_assistant", model: "model-router" }
  });
  rememberConversationTurn({
    userId: "user-a",
    sessionId: "session-travel",
    traceId: "trace-travel",
    userMessage: "Plan a three-day trip to Tokyo.",
    assistantResponse: "Start in Asakusa and continue to Ueno.",
    metadata: { specialist: "research_assistant" }
  });

  const result = loadMemory({
    userId: "user-a",
    sessionId: "session-new",
    query: "What were my exercise plan preferences?"
  });

  assert.equal(result.status, "success");
  assert.equal(result.retrieval.scope, "current_user");
  assert.equal(result.retrieval.strategy, "hybrid_lexical_faceted_lifecycle_v3");
  assert.equal(result.memories[0].source.trace_id, "trace-exercise");
  assert.match(result.memories[0].content, /short exercise plans/);
  assert.ok(result.memories[0].relevance_score > 0);
  assert.ok(result.retrieval.context_characters > 0);
});

test("load_memory 强制用户隔离并支持中文查询", () => {
  rememberConversationTurn({
    userId: "user-b",
    sessionId: "session-boston",
    traceId: "trace-boston",
    userMessage: "我喜欢紫色、花卉和艺术感的约会地点。",
    assistantResponse: "可以优先考虑美术馆和植物园。"
  });
  rememberConversationTurn({
    userId: "user-secret",
    sessionId: "session-secret",
    traceId: "trace-secret",
    userMessage: "My private preference is coastal travel.",
    assistantResponse: "Saved."
  });

  const chinese = loadMemory({ userId: "user-b", sessionId: "session-new", query: "我之前喜欢什么样的约会地点？" });
  assert.equal(chinese.memories[0].source.trace_id, "trace-boston");
  assert.match(chinese.memories[0].content, /紫色/);

  const isolated = loadMemory({ userId: "user-b", sessionId: "session-new", query: "coastal travel" });
  assert.equal(isolated.memories.length, 0);
});

test("记忆策略直接拒绝凭证，不保存脱敏后的占位符", () => {
  const result = rememberConversationTurn({
    userId: "user-c",
    sessionId: "session-redaction",
    traceId: "trace-redaction",
    userMessage: "Remember this API key: test-credential-value",
    assistantResponse: "I will not retain the raw credential."
  });
  assert.equal(result.stored, false);
  assert.equal(result.reason, "sensitive_content");
  assert.equal(loadMemory({ userId: "user-c", sessionId: "session-new", query: "token remember" }).memories.length, 0);
});

test("姓名可跨 Session、跨中英文语义召回，姓名问题不会覆盖已有事实", () => {
  const stored = rememberConversationTurn({
    userId: "user-identity",
    sessionId: "session-introduction",
    traceId: "trace-introduction",
    userMessage: "My name is Andrew Zheng.",
    assistantResponse: "Nice to meet you, Andrew."
  });
  assert.equal(stored.stored, true);
  assert.equal(stored.memory_key, "profile:identity-name");

  const english = loadMemory({
    userId: "user-identity",
    sessionId: "session-recall-en",
    query: "user identity"
  });
  assert.match(english.memories[0].content, /Andrew Zheng/u);
  assert.match(english.memories[0].match_reason, /^memory_(?:key|kind):/u);

  const chinese = loadMemory({
    userId: "user-identity",
    sessionId: "session-recall-zh",
    query: "用户名字"
  });
  assert.match(chinese.memories[0].content, /Andrew Zheng/u);

  const question = rememberConversationTurn({
    userId: "user-identity",
    sessionId: "session-recall-zh",
    traceId: "trace-recall-zh",
    userMessage: "你知道我叫什么名字吗",
    assistantResponse: "你叫 Andrew Zheng。"
  });
  assert.equal(question.stored, false);
  assert.equal(question.reason, "question_not_memory");
  assert.deepEqual(listMemories("user-identity").map(memory => memory.content), ["My name is Andrew Zheng."]);
});

test("长期记忆只写入可复用信息，并允许用户禁用和删除", () => {
  assert.equal(memoryWriteDecision("巴黎是法国的首都吗？").shouldWrite, false);
  const skipped = rememberConversationTurn({
    userId: "user-policy",
    sessionId: "session-policy",
    traceId: "trace-transient",
    userMessage: "巴黎是法国的首都吗？",
    assistantResponse: "是。"
  });
  assert.equal(skipped.stored, false);

  const stored = rememberConversationTurn({
    userId: "user-policy",
    sessionId: "session-policy",
    traceId: "trace-preference",
    userMessage: "我喜欢简洁的中文回答。",
    assistantResponse: "好的，我会尽量保持简洁。"
  });
  assert.equal(stored.stored, true);
  assert.equal(stored.kind, "preference");
  assert.match(stored.content, /简洁/u);
  assert.equal(listMemories("user-policy").length, 1);

  setMemoryEnabled({ userId: "user-policy", enabled: false });
  assert.equal(getMemorySettings("user-policy").enabled, false);
  assert.equal(loadMemory({ userId: "user-policy", sessionId: "session-new", query: "回答偏好" }).returned_count, 0);
  setMemoryEnabled({ userId: "user-policy", enabled: true });
  assert.equal(deleteMemory({ userId: "user-policy", memoryId: stored.memory_id }).deleted, true);
  assert.equal(listMemories("user-policy").length, 0);
});

test("同一主题的新记忆会保留历史并取代旧值，忘记请求只影响当前用户", () => {
  const oldValue = rememberConversationTurn({
    userId: "user-conflict",
    sessionId: "session-one",
    traceId: "trace-old-language",
    userMessage: "以后回答默认使用英文。",
    assistantResponse: "好的。"
  });
  const newValue = rememberConversationTurn({
    userId: "user-conflict",
    sessionId: "session-two",
    traceId: "trace-new-language",
    userMessage: "以后回答默认使用中文。",
    assistantResponse: "好的。"
  });
  assert.equal(oldValue.memory_key, newValue.memory_key);
  assert.equal(newValue.superseded_count, 1);
  assert.deepEqual(listMemories("user-conflict").map(item => item.content), ["以后回答默认使用中文。"]);

  const forgotten = rememberConversationTurn({
    userId: "user-conflict",
    sessionId: "session-three",
    traceId: "trace-forget-language",
    userMessage: "请忘记我的回答语言偏好。",
    assistantResponse: "好的。"
  });
  assert.equal(forgotten.action, "forget");
  assert.equal(forgotten.deleted_count, 1);
  assert.equal(listMemories("user-conflict").length, 0);
});

test("记忆按类型设置有效期并可执行确定性过期清理", () => {
  const stored = rememberConversationTurn({
    userId: "user-expiry",
    sessionId: "session-expiry",
    traceId: "trace-expiry",
    userMessage: "我是产品经理。",
    assistantResponse: "了解。",
    now: new Date("2024-01-01T00:00:00.000Z")
  });
  assert.equal(stored.kind, "profile");
  assert.ok(stored.expires_at);
  assert.equal(cleanupExpiredMemories(new Date("2027-01-01T00:00:00.000Z")).deactivated >= 1, true);
  assert.equal(listMemories("user-expiry").length, 0);
});
