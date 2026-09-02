import assert from "node:assert/strict";
import test from "node:test";

import {
  createEvalRun,
  deleteSession,
  fetchCurrentUser,
  fetchEvalDatasetItems,
  fetchEvalDatasets,
  fetchEvalRun,
  fetchEvalRuns,
  fetchFeedbackEvidence,
  streamChat,
  updateEvalRun,
  updateGoldenSetLifecycle
} from "../src/web/api-client.mjs";

test("浏览器 API Client 能解析跨数据块的 NDJSON 运行事件", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"span","event":{"id":"span-1"}}\n{"type":"res'));
      controller.enqueue(encoder.encode('ult","result":{"answer":"完成"}}\n'));
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  try {
    const messages = [];
    const result = await streamChat({
      prompt: "测试",
      sessionId: "session-test",
      requestId: "request-test",
      model: "model-router",
      onMessage: message => messages.push(message)
    });
    assert.equal(result.answer, "完成");
    assert.deepEqual(messages.map(item => item.type), ["span", "result"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("浏览器 API Client 使用独立 DELETE 端点删除会话", async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (input, init = {}) => {
    captured = { input: String(input), init };
    return Response.json({ deleted: true, sessionId: "session-delete-001" });
  };
  try {
    const result = await deleteSession("session-delete-001");
    assert.deepEqual(result, { deleted: true, sessionId: "session-delete-001" });
    assert.equal(captured.input, "/api/sessions/session-delete-001");
    assert.equal(captured.init.method, "DELETE");
    assert.equal(captured.init.headers.Accept, "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("浏览器 API Client 按候选 ID 延迟读取评估证据", async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (input, init = {}) => {
    captured = { input: String(input), init };
    return Response.json({ evidence: { id: "evd-123456789012345678901234" } });
  };
  try {
    const payload = await fetchFeedbackEvidence("gfc-123456789012345678901234");
    assert.equal(payload.evidence.id, "evd-123456789012345678901234");
    assert.equal(captured.input, "/api/eval/feedback-candidates/gfc-123456789012345678901234/evidence");
    assert.equal(captured.init.headers.Accept, "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("浏览器 API Client 支持 Dataset Catalog、生命周期筛选与归档", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init });
    return Response.json(String(input).includes("/items")
      ? { dataset_id: "feedback-golden", items: [] }
      : String(input).includes("golden-set")
        ? { item: { golden_id: "gold-123456789012345678901234", lifecycle_status: "archived" } }
        : { datasets: [], summary: {} });
  };
  try {
    await fetchEvalDatasets();
    await fetchEvalDatasetItems("feedback-golden", "archived");
    await updateGoldenSetLifecycle("gold-123456789012345678901234", "archive");
    assert.equal(requests[0].input, "/api/eval/datasets");
    assert.equal(requests[1].input, "/api/eval/datasets/feedback-golden/items?status=archived");
    assert.equal(requests[2].input, "/api/eval/golden-set/gold-123456789012345678901234");
    assert.equal(requests[2].init.method, "PATCH");
    assert.deepEqual(JSON.parse(requests[2].init.body), { action: "archive" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("浏览器 API Client 支持 Eval Run 创建、查询与生命周期操作", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init });
    return Response.json(String(input) === "/api/eval/runs?lifecycle=archived"
      ? { runs: [], summary: {} }
      : { run: { id: "evr-123456789012345678901234", execution_status: "draft" } }, { status: init.method === "POST" ? 201 : 200 });
  };
  try {
    await fetchEvalRuns("archived");
    await fetchEvalRun("evr-123456789012345678901234");
    await createEvalRun({ name: "Core run", profile: "local", datasetIds: ["core"], start: false });
    await updateEvalRun("evr-123456789012345678901234", "rerun", { confirmLive: false });
    assert.equal(requests[0].input, "/api/eval/runs?lifecycle=archived");
    assert.equal(requests[1].input, "/api/eval/runs/evr-123456789012345678901234");
    assert.equal(requests[2].init.method, "POST");
    assert.deepEqual(JSON.parse(requests[2].init.body), { name: "Core run", profile: "local", datasetIds: ["core"], start: false });
    assert.equal(requests[3].init.method, "PATCH");
    assert.deepEqual(JSON.parse(requests[3].init.body), { action: "rerun", confirmLive: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("浏览器 API Client 不向英文界面透传中文后端错误", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(
    { code: "unauthorized", error: "请先登录" },
    { status: 401 }
  );
  try {
    await assert.rejects(fetchCurrentUser(), error => {
      assert.match(error.message, /Sign in to continue/u);
      assert.doesNotMatch(error.message, /[\u3400-\u9fff]/u);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
