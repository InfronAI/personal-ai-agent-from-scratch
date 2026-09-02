import assert from "node:assert/strict";
import test from "node:test";

import { routingSystem } from "../workflow.mjs";

test("明确的 PDF 请求会覆盖不安全的直接回答决策", () => {
  const intent = routingSystem.intent.route({ prompt: "请把这三点整理成一份 PDF 报告" });
  const decision = routingSystem.agent.route({ intent, proposal: { mode: "direct", agentId: null } });
  assert.equal(intent.ruleId, "explicit-document-generation");
  assert.equal(intent.constraints.requestedFormat, "pdf");
  assert.equal(decision.decision.mode, "delegate");
  assert.equal(decision.decision.agentId, "document_generator_assistant");
  assert.equal(decision.policy.action, "override");
});

test("稳定的一般问题保留模型的直接回答决策", () => {
  const intent = routingSystem.intent.route({ prompt: "你好，今天心情如何？" });
  const decision = routingSystem.agent.route({ intent, proposal: { mode: "direct", agentId: null } });
  assert.deepEqual(decision.decision, { mode: "direct", agentId: null });
  assert.equal(decision.policy.action, "allow");
});
