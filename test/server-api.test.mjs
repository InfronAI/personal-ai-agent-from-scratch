import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-server-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "copilot.sqlite");
process.env.COPILOT_ARTIFACT_DIRECTORY = join(directory, "artifacts");
process.env.COPILOT_RUNTIME_CONFIG_PATH = join(directory, "runtime-settings.json");
process.env.COPILOT_ALLOW_WEB_CONFIGURATION = "true";
process.env.COPILOT_SESSION_SECRET = "copilot-server-test-session-secret-0000000000000000";
process.env.LLM_GATEWAY_API_KEY = "test-gateway-secret-initial";
process.env.WEB_SEARCH_API_KEY = "";
process.env.LANGFUSE_PUBLIC_KEY = "";
process.env.LANGFUSE_SECRET_KEY = "";
process.env.LANGFUSE_BASE_URL = "";

const { createApplicationServer } = await import(`../server.mjs?test=${Date.now()}`);
const { closeDatabase, database } = await import("../database.mjs");

const runAgentTurn = async request => {
  request.onRuntimeEvent?.({
    type: "span",
    event: {
      schemaVersion: "copilot-runtime-event.v1",
      sequence: 1,
      id: "span-api-test",
      parentId: null,
      traceId: "0123456789abcdef0123456789abcdef",
      sessionId: request.sessionId,
      requestId: request.requestId,
      kind: "CHAIN",
      name: "invocation [api-test]",
      semanticRole: null,
      actor: "测试运行时",
      status: "completed",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString(),
      durationMs: 1,
      duration: "1 ms",
      summary: "测试完成",
      input: { prompt: request.prompt },
      output: { answer: "API 测试回答" },
      metadata: {}
    }
  });
  return {
    answer: "API 测试回答",
    traceId: "0123456789abcdef0123456789abcdef",
    sessionId: request.sessionId,
    requestId: request.requestId,
    specialist: "copilot",
    routing: {
      schemaVersion: "copilot-routing-decision.v1",
      intent: { schemaVersion: "copilot-intent-decision.v1", taskType: "general_assistance", risk: { level: "low" } },
      agent: { schemaVersion: "copilot-agent-route.v1", decision: { mode: "direct", agentId: null } }
    },
    model: "model-router",
    resolvedModel: "test/model",
    runtime: [{
      schemaVersion: "copilot-runtime-event.v1",
      sequence: 1,
      id: "span-api-test",
      parentId: null,
      traceId: "0123456789abcdef0123456789abcdef",
      sessionId: request.sessionId,
      requestId: request.requestId,
      kind: "CHAIN",
      name: "invocation [api-test]",
      status: "completed",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString(),
      durationMs: 1,
      duration: "1 ms",
      summary: "测试完成",
      input: { prompt: request.prompt },
      output: { answer: "API 测试回答" },
      metadata: {}
    }],
    artifacts: [],
    tool: null
  };
};

const setupRequests = [];
let setupResponseStatus = 200;
const setupFetch = async (input, init = {}) => {
  setupRequests.push({ input: String(input), init });
  return Response.json(setupResponseStatus === 200 ? {
    id: "setup-test-completion",
    model: "test/intention-model",
    choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }]
  } : { error: { code: setupResponseStatus, message: "测试拒绝" } }, { status: setupResponseStatus });
};
const server = createApplicationServer({ runAgentTurn, fetch: setupFetch });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function login(username) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl },
    body: JSON.stringify({ username })
  });
  assert.equal(response.status, 200);
  return {
    cookie: response.headers.get("set-cookie").split(";")[0],
    payload: await response.json()
  };
}

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("Web UI 通过受限静态路由提供本地设计字体", async () => {
  const response = await fetch(`${baseUrl}/assets/fonts/GeneralSans-Regular.woff2`, { headers: { "Accept": "font/woff2" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "font/woff2");
  assert.ok((await response.arrayBuffer()).byteLength > 1_000);
});

test("Eval Run API 按用户隔离 Draft、详情与归档生命周期", async () => {
  const owner = await login("EvalRunOwner");
  const createResponse = await fetch(`${baseUrl}/api/eval/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": owner.cookie },
    body: JSON.stringify({ name: "Core contract gate", profile: "local", datasetIds: ["core"] })
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).run;
  assert.match(created.id, /^evr-[a-f0-9]{24}$/u);
  assert.equal(created.execution_status, "draft");

  const listResponse = await fetch(`${baseUrl}/api/eval/runs?lifecycle=active`, {
    headers: { "Accept": "application/json", "Cookie": owner.cookie }
  });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.schemaVersion, "copilot-eval-runs.v1");
  assert.equal(list.runs[0].id, created.id);
  assert.ok(list.configuration.profiles.some(profile => profile.id === "live-judged" && profile.requires_confirmation));
  assert.ok(list.configuration.datasets.some(dataset => dataset.id === "core" && dataset.item_count === 19));

  const other = await login("EvalRunReader");
  const forbiddenDetail = await fetch(`${baseUrl}/api/eval/runs/${created.id}`, {
    headers: { "Accept": "application/json", "Cookie": other.cookie }
  });
  assert.equal(forbiddenDetail.status, 404);

  const archiveResponse = await fetch(`${baseUrl}/api/eval/runs/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": owner.cookie },
    body: JSON.stringify({ action: "archive" })
  });
  assert.equal(archiveResponse.status, 200);
  assert.equal((await archiveResponse.json()).run.lifecycle_status, "archived");
});

test("首次登录核心配置只向本地管理员开放，并经真实探测后按用户完成", async () => {
  const anonymous = await fetch(`${baseUrl}/api/setup`, { headers: { "Accept": "application/json" } });
  assert.equal(anonymous.status, 401);
  const owner = await login("SetupOwner");
  const initialResponse = await fetch(`${baseUrl}/api/setup`, {
    headers: { "Accept": "application/json", "Cookie": owner.cookie }
  });
  assert.equal(initialResponse.status, 200);
  const initialText = await initialResponse.text();
  assert.equal(initialText.includes("test-gateway-secret-initial"), false);
  const initial = JSON.parse(initialText);
  assert.equal(initial.onboarding.completed, false);
  assert.equal(initial.administration.canManage, true);
  assert.equal(initial.modelGateway.configured, true);
  assert.equal(initial.evaluationJudge.model, "openai/gpt-4o");
  assert.equal(initial.evaluationJudge.systemDefaultModel, "openai/gpt-4o");
  assert.equal(initial.evaluationJudge.modelSource, "system-default");

  const invalidJudgeUpdate = await fetch(`${baseUrl}/api/setup/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": owner.cookie },
    body: JSON.stringify({ judgeModel: "invalid judge model" })
  });
  assert.equal(invalidJudgeUpdate.status, 400);
  assert.equal((await invalidJudgeUpdate.json()).code, "invalid_setup_model");

  const updateResponse = await fetch(`${baseUrl}/api/setup/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": owner.cookie },
    body: JSON.stringify({
      llmApiKey: "test-gateway-secret-runtime",
      llmBaseUrl: "https://gateway.example/v1",
      intentionModel: "test/intention-model",
      judgeModel: "test/judge-model",
      searchBaseUrl: "https://search.example/v1/tavily",
      searchApiKey: "test-search-secret-runtime",
      langfuseBaseUrl: "https://cloud.langfuse.com",
      langfusePublicKey: "pk-lf-test-public-key",
      langfuseSecretKey: "sk-lf-test-secret-key",
      langfuseEnvironment: "test"
    })
  });
  assert.equal(updateResponse.status, 200);
  const updateText = await updateResponse.text();
  assert.equal(updateText.includes("test-gateway-secret-runtime"), false);
  assert.equal(updateText.includes("test-search-secret-runtime"), false);
  assert.equal(updateText.includes("sk-lf-test-secret-key"), false);
  const updatedSetup = JSON.parse(updateText);
  assert.equal(updatedSetup.modelGateway.apiKeySource, "web-runtime");
  assert.equal(updatedSetup.evaluationJudge.model, "test/judge-model");
  assert.equal(updatedSetup.evaluationJudge.modelSource, "web-runtime");
  assert.equal(updatedSetup.search.apiKeySource, "web-runtime");
  assert.equal(updatedSetup.search.apiKeyConfigured, true);
  assert.equal(updatedSetup.search.credentialRef, "WEB_SEARCH_API_KEY");
  const runtimeSettingsPath = join(directory, "runtime-settings.json");
  assert.equal(statSync(runtimeSettingsPath).mode & 0o777, 0o600);
  const storedRuntimeSettings = JSON.parse(readFileSync(runtimeSettingsPath, "utf8")).values;
  assert.equal(JSON.parse(readFileSync(runtimeSettingsPath, "utf8")).schemaVersion, "copilot-runtime-settings.v2");
  assert.equal(storedRuntimeSettings.LLM_GATEWAY_API_KEY, "test-gateway-secret-runtime");
  assert.equal(storedRuntimeSettings.COPILOT_EVAL_JUDGE_MODEL, "test/judge-model");
  assert.equal(storedRuntimeSettings.WEB_SEARCH_API_KEY, "test-search-secret-runtime");
  assert.equal(storedRuntimeSettings.LANGFUSE_BASE_URL, "https://cloud.langfuse.com");
  assert.equal(storedRuntimeSettings.LANGFUSE_PUBLIC_KEY, "pk-lf-test-public-key");
  assert.equal(storedRuntimeSettings.LANGFUSE_SECRET_KEY, "sk-lf-test-secret-key");
  assert.equal(storedRuntimeSettings.LANGFUSE_TRACING_ENVIRONMENT, "test");

  const completeResponse = await fetch(`${baseUrl}/api/setup/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": owner.cookie },
    body: "{}"
  });
  assert.equal(completeResponse.status, 200);
  const completed = await completeResponse.json();
  assert.equal(completed.onboarding.completed, true);
  assert.equal(completed.verification.status, "passed");
  assert.equal(completed.setup.onboarding.completed, true);
  assert.equal(setupRequests.length, 1);
  assert.match(setupRequests[0].input, /^https:\/\/gateway\.example\/v1\/chat\/completions$/u);
  assert.equal(setupRequests[0].init.headers.Accept, "application/json");
  assert.equal(setupRequests[0].init.headers.Connection, "close");
  assert.match(setupRequests[0].init.headers["User-Agent"], /^Personal-Copilot-Setup\//u);
  assert.equal(JSON.parse(setupRequests[0].init.body).max_tokens, 8);

  const other = await login("SetupReader");
  const otherSetup = await fetch(`${baseUrl}/api/setup`, {
    headers: { "Accept": "application/json", "Cookie": other.cookie }
  });
  const otherState = await otherSetup.json();
  assert.equal(otherState.administration.canManage, false);
  assert.equal(otherState.onboarding.completed, false);

  const forbiddenUpdate = await fetch(`${baseUrl}/api/setup/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": other.cookie },
    body: JSON.stringify({ llmApiKey: "other-user-secret", llmBaseUrl: "https://attacker.example/v1" })
  });
  assert.equal(forbiddenUpdate.status, 403);
  assert.equal((await forbiddenUpdate.json()).code, "setup_configuration_forbidden");

  setupResponseStatus = 401;
  const rejectedCompletion = await fetch(`${baseUrl}/api/setup/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": other.cookie },
    body: "{}"
  });
  assert.equal(rejectedCompletion.status, 401);
  assert.equal((await rejectedCompletion.json()).code, "setup_gateway_unauthorized");
  const stillPending = await fetch(`${baseUrl}/api/setup`, { headers: { "Accept": "application/json", "Cookie": other.cookie } });
  assert.equal((await stillPending.json()).onboarding.completed, false);
  setupResponseStatus = 200;
});

test("HTTP API 支持流式对话、服务端会话恢复和 Trace 反馈", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/sessions`, { headers: { "Accept": "application/json" } });
  assert.equal(unauthenticated.status, 401);

  const alice = await login("Alice");
  assert.equal(alice.payload.user.username, "Alice");
  const streamResponse = await fetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/x-ndjson", "Origin": baseUrl, "Cookie": alice.cookie },
    body: JSON.stringify({ prompt: "测试问题", sessionId: "copilot-api-session-0001", requestId: "request-api-0001" })
  });
  assert.equal(streamResponse.status, 200);
  const events = (await streamResponse.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ["accepted", "span", "result"]);
  assert.equal(events.at(-1).result.answer, "API 测试回答");

  const sessionsResponse = await fetch(`${baseUrl}/api/sessions`, { headers: { "Accept": "application/json", "Cookie": alice.cookie } });
  const sessions = await sessionsResponse.json();
  assert.equal(sessions.sessions[0].turns[0].requestId, "request-api-0001");

  const feedbackResponse = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": alice.cookie },
    body: JSON.stringify({ requestId: "request-api-0001", value: 1, comment: "回答有效" })
  });
  assert.equal(feedbackResponse.status, 200);
  const feedback = await feedbackResponse.json();
  assert.equal(feedback.feedback.value, 1);
  assert.equal(feedback.feedback.trace_id, "0123456789abcdef0123456789abcdef");
  assert.equal(feedback.candidate.review_status, "candidate");
  assert.equal(feedback.candidate.evaluation_evidence.trace_span_count, 1);
  assert.equal(feedback.candidate.evaluation_evidence.session_turn_count, 1);
  assert.equal(feedback.candidate.evaluation_evidence.excludes_future_turns, true);

  const candidateResponse = await fetch(`${baseUrl}/api/eval/feedback-candidates`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  });
  assert.equal(candidateResponse.status, 200);
  const candidates = (await candidateResponse.json()).candidates;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].request_id, "request-api-0001");

  const evidenceResponse = await fetch(`${baseUrl}/api/eval/feedback-candidates/${candidates[0].id}/evidence`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  });
  assert.equal(evidenceResponse.status, 200);
  const evidence = (await evidenceResponse.json()).evidence;
  assert.equal(evidence.snapshot.subject.requestId, "request-api-0001");
  assert.equal(evidence.snapshot.trace.trace.runtime.length, 1);
  assert.equal(evidence.snapshot.session.boundary.excludesFutureTurns, true);

  const reviewResponse = await fetch(`${baseUrl}/api/eval/feedback-candidates/${candidates[0].id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": alice.cookie },
    body: JSON.stringify({ decision: "approve", expectedOutput: "API 测试回答", expectedRoute: { mode: "direct", agentId: null } })
  });
  assert.equal(reviewResponse.status, 200);
  const reviewed = await reviewResponse.json();
  assert.equal(reviewed.candidate.review_status, "approved");
  assert.equal(reviewed.golden_item.metadata.label_status, "human-reviewed");

  const goldenResponse = await fetch(`${baseUrl}/api/eval/golden-set`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  });
  assert.equal(goldenResponse.status, 200);
  assert.equal((await goldenResponse.json()).items.length, 1);

  const catalogResponse = await fetch(`${baseUrl}/api/eval/datasets`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.schemaVersion, "copilot-eval-dataset-catalog.v2");
  assert.equal(catalog.summary.built_in_items, 140);
  assert.equal(catalog.summary.benchmark_families, 27);
  assert.equal(catalog.summary.feedback_active, 1);
  assert.equal(catalog.datasets.length, 19);
  assert.equal(catalog.datasets[0].id, "feedback-golden");

  const builtInItemsResponse = await fetch(`${baseUrl}/api/eval/datasets/core/items`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  });
  assert.equal(builtInItemsResponse.status, 200);
  const builtInItems = await builtInItemsResponse.json();
  assert.equal(builtInItems.items.length, 19);
  assert.equal(builtInItems.items[0].read_only, true);
  assert.equal(Object.hasOwn(builtInItems.items[0].input, "script"), false);

  const goldenId = reviewed.golden_item.golden_id;
  const archiveResponse = await fetch(`${baseUrl}/api/eval/golden-set/${goldenId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": alice.cookie },
    body: JSON.stringify({ action: "archive" })
  });
  assert.equal(archiveResponse.status, 200);
  assert.equal((await archiveResponse.json()).item.lifecycle_status, "archived");
  const activeAfterArchive = await fetch(`${baseUrl}/api/eval/golden-set?status=active`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  }).then(response => response.json());
  assert.equal(activeAfterArchive.items.length, 0);
  const archivedAfterArchive = await fetch(`${baseUrl}/api/eval/datasets/feedback-golden/items?status=archived`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  }).then(response => response.json());
  assert.equal(archivedAfterArchive.items.length, 1);
  const restoreResponse = await fetch(`${baseUrl}/api/eval/golden-set/${goldenId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": alice.cookie },
    body: JSON.stringify({ action: "restore" })
  });
  assert.equal(restoreResponse.status, 200);
  assert.equal((await restoreResponse.json()).item.lifecycle_status, "active");

  const rescoredResponse = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": alice.cookie },
    body: JSON.stringify({ requestId: "request-api-0001", value: 0, comment: "不纳入回归" })
  });
  assert.equal(rescoredResponse.status, 200);
  const pendingAfterRescore = await fetch(`${baseUrl}/api/eval/feedback-candidates`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  }).then(response => response.json());
  assert.equal(pendingAfterRescore.candidates.length, 1);

  const rejectResponse = await fetch(`${baseUrl}/api/eval/feedback-candidates/${pendingAfterRescore.candidates[0].id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": alice.cookie },
    body: JSON.stringify({ decision: "reject" })
  });
  assert.equal(rejectResponse.status, 200);
  assert.equal((await rejectResponse.json()).removed_from_review_queue, true);
  const pendingAfterReject = await fetch(`${baseUrl}/api/eval/feedback-candidates`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  }).then(response => response.json());
  assert.deepEqual(pendingAfterReject.candidates, []);
  const rejectedAudit = await fetch(`${baseUrl}/api/eval/feedback-candidates?status=rejected`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  }).then(response => response.json());
  assert.equal(rejectedAudit.candidates.length, 1);
  assert.equal(rejectedAudit.candidates[0].review_status, "rejected");

  const bob = await login("Bob");
  const bobSessions = await fetch(`${baseUrl}/api/sessions`, { headers: { "Accept": "application/json", "Cookie": bob.cookie } });
  assert.deepEqual((await bobSessions.json()).sessions, []);
  const bobCandidates = await fetch(`${baseUrl}/api/eval/feedback-candidates`, { headers: { "Accept": "application/json", "Cookie": bob.cookie } });
  assert.deepEqual((await bobCandidates.json()).candidates, []);
  const bobGolden = await fetch(`${baseUrl}/api/eval/golden-set`, { headers: { "Accept": "application/json", "Cookie": bob.cookie } });
  assert.deepEqual((await bobGolden.json()).items, []);
  const bobCatalog = await fetch(`${baseUrl}/api/eval/datasets`, { headers: { "Accept": "application/json", "Cookie": bob.cookie } }).then(response => response.json());
  assert.equal(bobCatalog.summary.built_in_items, 140);
  assert.equal(bobCatalog.summary.feedback_active, 0);
  const bobEvidence = await fetch(`${baseUrl}/api/eval/feedback-candidates/${candidates[0].id}/evidence`, {
    headers: { "Accept": "application/json", "Cookie": bob.cookie }
  });
  assert.equal(bobEvidence.status, 404);

  const bobCrossUserSession = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": bob.cookie },
    body: JSON.stringify({ prompt: "尝试访问其他用户会话", sessionId: "copilot-api-session-0001", requestId: "request-api-bob-0001" })
  });
  assert.equal(bobCrossUserSession.status, 403);
  assert.equal((await bobCrossUserSession.json()).code, "session_forbidden");

  const aliceAgain = await fetch(`${baseUrl}/api/sessions`, { headers: { "Accept": "application/json", "Cookie": alice.cookie } });
  assert.equal((await aliceAgain.json()).sessions.length, 1);

  const forbiddenDelete = await fetch(`${baseUrl}/api/sessions/copilot-api-session-0001`, {
    method: "DELETE",
    headers: { "Accept": "application/json", "Origin": baseUrl, "Cookie": bob.cookie }
  });
  assert.equal(forbiddenDelete.status, 403);
  assert.equal((await forbiddenDelete.json()).code, "session_forbidden");

  const deleteResponse = await fetch(`${baseUrl}/api/sessions/copilot-api-session-0001`, {
    method: "DELETE",
    headers: { "Accept": "application/json", "Origin": baseUrl, "Cookie": alice.cookie }
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json()).deleted, true);
  const sessionsAfterDelete = await fetch(`${baseUrl}/api/sessions`, { headers: { "Accept": "application/json", "Cookie": alice.cookie } });
  assert.deepEqual((await sessionsAfterDelete.json()).sessions, []);
  const rejectedAfterDelete = await fetch(`${baseUrl}/api/eval/feedback-candidates?status=rejected`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  });
  assert.deepEqual((await rejectedAfterDelete.json()).candidates, []);
  const goldenAfterDelete = await fetch(`${baseUrl}/api/eval/golden-set`, {
    headers: { "Accept": "application/json", "Cookie": alice.cookie }
  });
  assert.deepEqual((await goldenAfterDelete.json()).items, []);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM eval_evidence_snapshots").get().count, 0);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { "Accept": "application/json", "Origin": baseUrl, "Cookie": alice.cookie }
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/u);
});

test("HTTP API 拒绝跨源写请求", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://attacker.example" },
    body: JSON.stringify({ prompt: "测试", sessionId: "copilot-api-session-0002", requestId: "request-api-0002" })
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "forbidden_origin");
});

test("HTTP 服务只提供允许的前端模块", async () => {
  const moduleResponse = await fetch(`${baseUrl}/src/web/api-client.mjs`, { headers: { "Accept": "text/javascript" } });
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get("content-type"), /^text\/javascript/u);
  assert.match(await moduleResponse.text(), /export async function fetchSessions/u);

  const deniedResponse = await fetch(`${baseUrl}/src/config.mjs`, { headers: { "Accept": "text/javascript" } });
  assert.equal(deniedResponse.status, 404);
});

test("HTTP API 提供模型目录、记忆 CRUD 与用户隔离的文件上传", async () => {
  const owner = await login("MultimodalOwner");
  const modelResponse = await fetch(`${baseUrl}/api/models`, {
    headers: { "Accept": "application/json", "Cookie": owner.cookie }
  });
  assert.equal(modelResponse.status, 200);
  const modelCatalog = await modelResponse.json();
  assert.equal(modelCatalog.models.length, 16);
  assert.equal(modelCatalog.models.filter(model => model.id !== "model-router").length, 15);

  const createResponse = await fetch(`${baseUrl}/api/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": owner.cookie },
    body: JSON.stringify({ content: "我偏好简洁的中文回答。", kind: "preference", expiresInDays: 365 })
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).memory;
  assert.equal(created.kind, "preference");

  const updateResponse = await fetch(`${baseUrl}/api/memories/${created.memory_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": baseUrl, "Cookie": owner.cookie },
    body: JSON.stringify({ content: "我偏好三点式的中文回答。", kind: "constraint", expiresInDays: 90 })
  });
  assert.equal(updateResponse.status, 200);
  assert.match((await updateResponse.json()).memory.content, /三点式/u);

  const uploadResponse = await fetch(`${baseUrl}/api/artifacts/upload?fileName=diagram.png&sessionId=copilot-upload-session-0001`, {
    method: "POST",
    headers: { "Content-Type": "image/png", "Accept": "application/json", "Origin": baseUrl, "Cookie": owner.cookie },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01])
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()).artifact;
  assert.equal(uploaded.mime_type, "image/png");
  assert.match(uploaded.metadata.sha256, /^[a-f0-9]{64}$/u);

  const outsider = await login("MultimodalOutsider");
  const outsiderArtifacts = await fetch(`${baseUrl}/api/artifacts`, {
    headers: { "Accept": "application/json", "Cookie": outsider.cookie }
  });
  assert.deepEqual((await outsiderArtifacts.json()).artifacts, []);
  const outsiderDownload = await fetch(`${baseUrl}${uploaded.download_url}`, {
    headers: { "Accept": "image/png", "Cookie": outsider.cookie }
  });
  assert.equal(outsiderDownload.status, 404);

  const deleteResponse = await fetch(`${baseUrl}/api/memories/${created.memory_id}`, {
    method: "DELETE",
    headers: { "Accept": "application/json", "Origin": baseUrl, "Cookie": owner.cookie }
  });
  assert.equal(deleteResponse.status, 200);
});
