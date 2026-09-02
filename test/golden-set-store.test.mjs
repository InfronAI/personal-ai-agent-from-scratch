import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-golden-set-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "copilot.sqlite");

const { database, closeDatabase } = await import(`../database.mjs?golden=${Date.now()}`);
const store = await import(`../golden-set-store.mjs?golden=${Date.now()}`);
const evidenceStore = await import("../evaluation-evidence-store.mjs");
const { validateDatasetItem } = await import("../evals/lib/dataset.mjs");
let initialEvidence = null;

database.prepare("INSERT INTO local_users(id, username, normalized_username, active, created_at, updated_at, last_login_at) VALUES (?, ?, ?, 1, ?, ?, ?)")
  .run("usr-a", "Alice", "alice", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
database.prepare("INSERT INTO chat_sessions(id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
  .run("session-a", "usr-a", "测试", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
database.prepare("INSERT INTO chat_turns(request_id, session_id, user_id, prompt, answer, trace_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run(
    "request-before",
    "session-a",
    "usr-a",
    "先解释热力学系统",
    "先前回答。",
    "trace-before",
    JSON.stringify({ runtime: [{ id: "span-before", kind: "GENERATION", name: "prior generation", input: { prompt: "先解释热力学系统" }, output: { content: "先前回答。" } }] }),
    "2026-08-31T23:59:59.000Z"
  );
database.prepare("INSERT INTO chat_turns(request_id, session_id, user_id, prompt, answer, trace_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run(
    "request-a",
    "session-a",
    "usr-a",
    "请解释熵增定律",
    "这是一次待评审回答。",
    "trace-a",
    JSON.stringify({
      intent: { domain: "education" },
      routing: { agent: { decision: { mode: "delegate", agentId: "teaching_assistant" } } },
      runtime: [
        { id: "span-intent", kind: "GENERATION", name: "detect-intent", input: { messages: [{ role: "user", content: "请解释熵增定律" }] }, output: { taskType: "education" }, metadata: { api_key: "test-credential-value" } },
        { id: "span-answer", kind: "GENERATION", name: "final-answer", input: { image: "data:image/png;base64,AAAA" }, output: { content: "这是一次待评审回答。" } }
      ]
    }),
    "2026-09-01T00:00:00.000Z"
  );
database.prepare("INSERT INTO chat_turns(request_id, session_id, user_id, prompt, answer, trace_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run("request-future", "session-a", "usr-a", "这是后续问题", "这是后续回答。", "trace-future", JSON.stringify({ runtime: [{ id: "span-future" }] }), "2026-09-01T00:00:01.000Z");

after(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("点赞或点踩会进入当前用户的反馈候选池，但不会自动成为 Gold", () => {
  const candidate = store.captureFeedbackCandidate({
    userId: "usr-a",
    feedbackId: "feedback-a",
    requestId: "request-a",
    value: 0,
    comment: "解释不准确"
  });

  assert.equal(candidate.review_status, "candidate");
  assert.equal(candidate.prompt, "请解释熵增定律");
  assert.equal(candidate.evaluation_evidence.schema_version, "copilot-eval-evidence.v1");
  assert.equal(candidate.evaluation_evidence.scope, "target-trace+session-prefix");
  assert.equal(candidate.evaluation_evidence.trace_span_count, 2);
  assert.equal(candidate.evaluation_evidence.session_turn_count, 2);
  assert.equal(candidate.evaluation_evidence.session_span_count, 3);
  assert.equal(candidate.evaluation_evidence.excludes_future_turns, true);
  initialEvidence = candidate.evaluation_evidence;
  assert.deepEqual(candidate.input.messages, [
    { role: "user", content: "先解释热力学系统" },
    { role: "assistant", content: "先前回答。" },
    { role: "user", content: "请解释熵增定律" }
  ]);
  assert.equal(store.listFeedbackCandidates({ userId: "usr-a" }).length, 1);
  assert.equal(store.listFeedbackCandidates({ userId: "usr-b" }).length, 0);
  assert.equal(store.listGoldenSetItems({ userId: "usr-a" }).length, 0);

  const evidence = evidenceStore.evaluationEvidenceForCandidate({ userId: "usr-a", candidateId: candidate.id });
  assert.equal(evidence.snapshot.session.turns.length, 2);
  assert.equal(evidence.snapshot.session.turns.at(-1).requestId, "request-a");
  assert.equal(JSON.stringify(evidence.snapshot).includes("request-future"), false);
  assert.equal(JSON.stringify(evidence.snapshot).includes("test-credential-value"), false);
  assert.equal(JSON.stringify(evidence.snapshot).includes("data:image/png;base64,AAAA"), false);
  assert.equal(evidenceStore.evaluationEvidenceForCandidate({ userId: "usr-b", candidateId: candidate.id }), null);
});

test("服务启动式补齐对历史候选幂等恢复同一份时间点证据", () => {
  database.prepare("DELETE FROM eval_evidence_snapshots WHERE id = ?").run(initialEvidence.id);
  const candidate = store.listFeedbackCandidates({ userId: "usr-a" })[0];
  assert.equal(candidate.evaluation_evidence, null);
  const backfill = evidenceStore.backfillEvaluationEvidenceSnapshots();
  assert.deepEqual(backfill, { scanned: 1, captured: 1, remaining: 0 });
  const restored = store.listFeedbackCandidates({ userId: "usr-a" })[0].evaluation_evidence;
  assert.equal(restored.id, initialEvidence.id);
  assert.equal(restored.content_hash, initialEvidence.content_hash);
});

test("点踩候选必须补充期望行为后才可人工晋升 Golden Set", () => {
  const candidate = store.listFeedbackCandidates({ userId: "usr-a" })[0];
  assert.throws(
    () => store.reviewFeedbackCandidate({ userId: "usr-a", candidateId: candidate.id, decision: "approve" }),
    error => error.code === "golden_expected_behavior_required"
  );

  const reviewed = store.reviewFeedbackCandidate({
    userId: "usr-a",
    candidateId: candidate.id,
    decision: "approve",
    reviewer: "Alice",
    expectedOutput: "说明封闭系统总熵不会自发减少，并解释统计意义。",
    expectedRoute: { mode: "delegate", agentId: "teaching_assistant" },
    failureCodes: ["answer_incorrect"]
  });

  assert.equal(reviewed.candidate.review_status, "approved");
  assert.equal(reviewed.golden_item.metadata.label_status, "human-reviewed");
  assert.equal(reviewed.golden_item.input.messages.at(-1).content, "请解释熵增定律");
  assert.equal(reviewed.golden_item.input.messages.length, 3);
  assert.equal(reviewed.golden_item.expected.response.reference_answer.includes("封闭系统"), true);
  assert.doesNotThrow(() => validateDatasetItem(reviewed.golden_item, "反馈 Golden Set 数据项"));
  assert.equal(store.listGoldenSetItems({ userId: "usr-a" }).length, 1);
  const exported = store.exportableGoldenSetItems();
  assert.equal(exported.length, 1);
  assert.equal(exported[0].evidence.session.turns.length, 2);
  assert.equal(exported[0].evidence.trace.trace.runtime.length, 2);
  assert.equal(exported[0].metadata.evidence_snapshot_id, reviewed.golden_item.metadata.evidence_snapshot_id);
  assert.doesNotThrow(() => validateDatasetItem(exported[0], "带证据的反馈 Golden Set 数据项"));
});

test("Golden Set 数据项支持可恢复归档，并保持用户隔离", () => {
  const active = store.listGoldenSetItems({ userId: "usr-a", status: "active" });
  assert.equal(active.length, 1);
  const archived = store.updateGoldenSetItemLifecycle({ userId: "usr-a", goldenId: active[0].golden_id, action: "archive" });
  assert.equal(archived.lifecycle_status, "archived");
  assert.equal(store.listGoldenSetItems({ userId: "usr-a", status: "active" }).length, 0);
  assert.equal(store.listGoldenSetItems({ userId: "usr-a", status: "archived" }).length, 1);
  assert.equal(store.listGoldenSetItems({ userId: "usr-a", status: "all" }).length, 1);
  assert.throws(
    () => store.updateGoldenSetItemLifecycle({ userId: "usr-b", goldenId: active[0].golden_id, action: "restore" }),
    error => error.code === "golden_item_not_found"
  );
  const restored = store.updateGoldenSetItemLifecycle({ userId: "usr-a", goldenId: active[0].golden_id, action: "restore" });
  assert.equal(restored.lifecycle_status, "active");
  assert.equal(store.feedbackDatasetSummary({ userId: "usr-a" }).active, 1);
});

test("重新评分会撤销旧 Gold 并要求重新审核", () => {
  const candidate = store.captureFeedbackCandidate({
    userId: "usr-a",
    feedbackId: "feedback-a",
    requestId: "request-a",
    value: 1,
    comment: "重新评估"
  });

  assert.equal(candidate.review_status, "candidate");
  assert.equal(candidate.evaluation_evidence.id, initialEvidence.id);
  assert.equal(candidate.evaluation_evidence.content_hash, initialEvidence.content_hash);
  assert.equal(store.listGoldenSetItems({ userId: "usr-a" }).length, 0);
});

test("拒绝后从待审候选集中移除，但保留可查询的审核记录", () => {
  const candidate = store.listFeedbackCandidates({ userId: "usr-a" })[0];
  const reviewed = store.reviewFeedbackCandidate({
    userId: "usr-a",
    candidateId: candidate.id,
    decision: "reject",
    reviewer: "Alice"
  });

  assert.equal(reviewed.removed_from_review_queue, true);
  assert.equal(reviewed.candidate.review_status, "rejected");
  assert.equal(reviewed.golden_item, null);
  assert.deepEqual(store.listFeedbackCandidates({ userId: "usr-a" }), []);
  assert.equal(store.listFeedbackCandidates({ userId: "usr-a", status: "rejected" }).length, 1);
  assert.equal(store.listFeedbackCandidates({ userId: "usr-a", status: "all" }).length, 1);
});
