import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-feedback-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "copilot.sqlite");

const store = await import(`../feedback-store.mjs?test=${Date.now()}`);
const { closeDatabase } = await import("../database.mjs");

after(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("用户反馈使用稳定幂等键，并支持修改同一轮评分", () => {
  const first = store.saveUserFeedback({
    userId: "user-a",
    sessionId: "session-a",
    requestId: "request-a",
    traceId: "0123456789abcdef0123456789abcdef",
    value: 1,
    comment: "有帮助"
  });
  const updated = store.saveUserFeedback({
    userId: "user-a",
    sessionId: "session-a",
    requestId: "request-a",
    traceId: "0123456789abcdef0123456789abcdef",
    value: 0,
    comment: "需要补充来源"
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.value, 0);
  assert.equal(store.feedbackForRequest({ userId: "user-a", requestId: "request-a" }).length, 1);
  assert.equal(store.feedbackForRequest({ userId: "user-b", requestId: "request-a" }).length, 0);
});

