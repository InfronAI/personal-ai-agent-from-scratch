import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "agent-runtime-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "copilot.sqlite");
process.env.COPILOT_SESSION_SECRET = "agent-runtime-test-session-secret-0000000000000000";
process.env.LANGFUSE_PUBLIC_KEY = "";
process.env.LANGFUSE_SECRET_KEY = "";
process.env.LANGFUSE_BASE_URL = "";

const { runAgentTurn } = await import(`../agent-runtime.mjs?test=${Date.now()}`);
const { closeDatabase } = await import("../database.mjs");

after(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("未启用遥测导出器时 Runtime ID 仍唯一且 History 完整保留", async () => {
  const history = Array.from({ length: 5 }, (_, index) => [
    { role: "user", content: `Constraint ${index + 1}` },
    { role: "assistant", content: `Recorded ${index + 1}` }
  ]).flat();
  let memoryWrite = null;
  const result = await runAgentTurn({
    prompt: "Summarize the constraints.",
    sessionId: "agent-runtime-test-session",
    requestId: "agent-runtime-test-request",
    userId: "agent-runtime-test-user",
    history,
    dependencies: {
      requestCompletion: async request => ({
        content: "All five constraints are preserved.",
        toolCalls: [],
        responseMessage: { role: "assistant", content: "All five constraints are preserved." },
        messages: request.messages,
        model: "eval/auto",
        configuredModel: request.model,
        provider: "test",
        responseId: "test-response",
        finishReason: "stop",
        completionStartTime: new Date(0),
        maxTokens: request.maxTokens,
        completionRetries: 0,
        usage: { input: 1, output: 1, total: 2, cachedInput: 0, reasoning: 0 }
      }),
      searchWithTavily: async () => { throw new Error("search must not run"); },
      loadMemory: () => ({ status: "success", memories: [], returned_count: 0, retrieval: {} }),
      rememberConversationTurn: value => {
        memoryWrite = value;
        return { action: "upsert", stored: true, memory_id: "test-memory", kind: "preference", policy_version: "test-policy" };
      }
    }
  });

  assert.equal(/^0+$/.test(result.traceId), false);
  assert.equal(new Set(result.runtime.map(event => event.id)).size, result.runtime.length);
  assert.deepEqual(new Set(result.runtime.map(event => event.kind)), new Set(["CHAIN", "AGENT RUN", "SPAN", "GENERATION"]));
  const generation = result.runtime.find(event => event.kind === "GENERATION");
  assert.ok(generation);
  for (const message of history) {
    assert.ok(generation.input.messages.some(candidate => candidate.role === message.role && candidate.content === message.content));
  }
  assert.equal(memoryWrite.traceId, result.traceId);
  const memoryCapture = result.runtime.find(event => event.name === "memory_capture");
  assert.equal(memoryCapture.semanticRole, "memory-write");
  assert.equal(memoryCapture.output.memory_id, "test-memory");
});

test("长期记忆旁路失败时保留主回答并输出可诊断 Span", async () => {
  const result = await runAgentTurn({
    prompt: "Please answer directly.",
    sessionId: "copilot-agent-memory-failure-session",
    requestId: "copilot-agent-memory-failure-request",
    userId: "copilot-agent-memory-failure-user",
    dependencies: {
      requestCompletion: async request => ({
        content: "The primary answer remains available.",
        toolCalls: [],
        responseMessage: { role: "assistant", content: "The primary answer remains available." },
        messages: request.messages,
        model: "eval/auto",
        configuredModel: request.model,
        provider: "test",
        responseId: "test-response-memory-failure",
        finishReason: "stop",
        completionStartTime: new Date(0),
        maxTokens: request.maxTokens,
        completionRetries: 0,
        usage: { input: 1, output: 1, total: 2, cachedInput: 0, reasoning: 0 }
      }),
      rememberConversationTurn: () => {
        const error = new Error("test memory failure");
        error.code = "test_memory_failure";
        throw error;
      }
    }
  });

  assert.equal(result.answer, "The primary answer remains available.");
  assert.equal(result.memory.reason, "memory_write_failed");
  const memoryCapture = result.runtime.find(event => event.name === "memory_capture");
  assert.equal(memoryCapture.status, "error");
  assert.equal(memoryCapture.output.error_code, "test_memory_failure");
});

test("Required Agent 路由会覆盖未知模型提议并执行注册表中的安全目标", async () => {
  const calls = [];
  const result = await runAgentTurn({
    prompt: "我头痛两天了，应该怎么办？",
    sessionId: "copilot-agent-policy-override-session",
    requestId: "copilot-agent-policy-override-request",
    userId: "copilot-agent-policy-override-user",
    dependencies: {
      listArtifacts: () => [],
      requestCompletion: async request => {
        calls.push(request.agentName);
        const isRoot = request.agentName === "copilot";
        const toolCalls = isRoot ? [{
          id: "invalid-agent-proposal",
          type: "function",
          function: { name: "transfer_to_agent", arguments: JSON.stringify({ agent_name: "unknown_agent" }) }
        }] : [];
        const content = isRoot ? "" : "持续或加重的头痛需要由医疗专业人员评估；若伴随突发剧痛、意识异常或肢体无力，请立即就医。";
        return {
          content,
          toolCalls,
          responseMessage: { role: "assistant", content: content || null, tool_calls: toolCalls },
          messages: request.messages,
          model: "eval/auto",
          configuredModel: request.model,
          provider: "test",
          responseId: `test-response-${calls.length}`,
          finishReason: toolCalls.length ? "tool_calls" : "stop",
          completionStartTime: new Date(0),
          maxTokens: request.maxTokens,
          completionRetries: 0,
          usage: { input: 1, output: 1, total: 2, cachedInput: 0, reasoning: 0 }
        };
      },
      rememberConversationTurn: () => ({ action: "skip", stored: false, reason: "not_reusable", policy_version: "test-policy" })
    }
  });

  assert.deepEqual(calls, ["copilot", "medical_assistant"]);
  assert.equal(result.specialist, "medical_assistant");
  assert.equal(result.routing.agent.proposal.valid, false);
  assert.equal(result.routing.agent.policy.action, "override");
  assert.equal(result.routing.agent.decision.agentId, "medical_assistant");
});

test("显式回答模型不会覆盖固定的 Intention Layer 模型", async () => {
  const calls = [];
  const result = await runAgentTurn({
    prompt: "用一句话解释熵增。",
    sessionId: "copilot-agent-explicit-model-session",
    requestId: "copilot-agent-explicit-model-request",
    userId: "copilot-agent-explicit-model-user",
    model: "gpt-5-4-mini",
    dependencies: {
      listArtifacts: () => [],
      prepareModelAttachments: () => ({ artifacts: [], parts: [], requiredModalities: [], missingArtifactNames: [], totalBytes: 0 }),
      requestCompletion: async request => {
        calls.push({ semanticRole: request.semanticRole, model: request.model });
        const content = request.semanticRole === "intent-routing"
          ? "This request should be answered directly."
          : "孤立系统的总熵不会自发减少。";
        return {
          content,
          toolCalls: [],
          responseMessage: { role: "assistant", content },
          messages: request.messages,
          model: request.model,
          configuredModel: request.model,
          provider: "test",
          responseId: `test-model-${calls.length}`,
          finishReason: "stop",
          completionStartTime: new Date(0),
          maxTokens: request.maxTokens,
          completionRetries: 0,
          usage: { input: 1, output: 1, total: 2, cachedInput: 0, reasoning: 0 }
        };
      },
      rememberConversationTurn: () => ({ action: "skip", stored: false, reason: "not_reusable", policy_version: "test-policy" })
    }
  });

  assert.deepEqual(calls, [
    { semanticRole: "intent-routing", model: "google/gemini-3.1-flash-lite" },
    { semanticRole: "direct-response", model: "openai/gpt-5.4-mini" }
  ]);
  assert.equal(result.answer, "孤立系统的总熵不会自发减少。");
  assert.equal(result.model, "gpt-5-4-mini");
  assert.equal(result.intentionModel, "google/gemini-3.1-flash-lite");
  assert.equal(result.routing.directModel.selectionSource, "user");
});
