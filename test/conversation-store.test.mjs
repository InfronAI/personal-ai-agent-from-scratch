import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-conversation-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "copilot.sqlite");
const store = await import(`../conversation-store.mjs?test=${Date.now()}`);
const { closeDatabase } = await import("../database.mjs");

after(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("服务端权威历史按 Session Owner 隔离", () => {
  const prepared = store.prepareConversation({ sessionId: "copilot-session-100", requestId: "request-100", userId: "usr_a" });
  assert.deepEqual(prepared.history, []);
  const result = { answer: "Stored answer", traceId: "trace-100", sessionId: prepared.sessionId };
  store.saveCompletedTurn({ requestId: prepared.requestId, sessionId: prepared.sessionId, userId: "usr_a", prompt: "Stored prompt", result });

  const followup = store.prepareConversation({ sessionId: "copilot-session-100", requestId: "request-101", userId: "usr_a" });
  assert.deepEqual(followup.history, [
    { role: "user", content: "Stored prompt" },
    { role: "assistant", content: "Stored answer" }
  ]);
  assert.equal(store.ownsTrace("trace-100", "usr_a"), true);
  assert.equal(store.ownsTrace("trace-100", "usr_b"), false);
  assert.throws(
    () => store.prepareConversation({ sessionId: "copilot-session-100", requestId: "request-102", userId: "usr_b" }),
    error => error.code === "session_forbidden"
  );
});

test("Request ID 保证已完成 Turn 幂等", () => {
  const replay = store.prepareConversation({ sessionId: "copilot-session-100", requestId: "request-100", userId: "usr_a" });
  assert.equal(replay.cachedResult.answer, "Stored answer");
  assert.equal(replay.cachedResult.traceId, "trace-100");
  assert.throws(
    () => store.prepareConversation({ sessionId: "copilot-session-200", requestId: "request-100", userId: "usr_a" }),
    error => error.code === "idempotency_conflict"
  );
});

test("删除会话只允许 Owner，并级联删除服务端轮次", () => {
  const prepared = store.prepareConversation({ sessionId: "copilot-session-delete", requestId: "request-delete-100", userId: "usr_delete" });
  store.saveCompletedTurn({
    requestId: prepared.requestId,
    sessionId: prepared.sessionId,
    userId: "usr_delete",
    prompt: "待删除问题",
    result: { answer: "待删除回答", traceId: "trace-delete-100", sessionId: prepared.sessionId }
  });
  assert.throws(
    () => store.deleteConversation({ sessionId: prepared.sessionId, userId: "usr_other" }),
    error => error.code === "session_forbidden"
  );
  assert.deepEqual(store.deleteConversation({ sessionId: prepared.sessionId, userId: "usr_delete" }), {
    deleted: true,
    sessionId: prepared.sessionId
  });
  assert.deepEqual(store.listConversations("usr_delete"), []);
  assert.equal(store.ownsTrace("trace-delete-100", "usr_delete"), false);
});
