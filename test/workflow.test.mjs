import assert from "node:assert/strict";
import test from "node:test";

import { workflowAgent, workflowStatus } from "../workflow.mjs";

test("copilot 只公开具有本地可执行工作流的 Agent", () => {
  const root = workflowAgent("copilot");
  const transfer = root.tools.find(tool => tool.function.name === "transfer_to_agent");
  const targetEnum = transfer.function.parameters.properties.agent_name.enum;
  assert.deepEqual(targetEnum, workflowStatus().agentRegistry.agents.find(agent => agent.id === "copilot").routableAgentIds);
  for (const target of targetEnum) assert.ok(workflowAgent(target), `${target} must have an executable prompt`);
  for (const removed of ["financial_assistant", "stalker", "image_creative_assistant", "video_creative_assistant"]) {
    assert.equal(targetEnum.includes(removed), false);
    assert.equal(root.systemPrompt.includes(`Agent name: ${removed.replaceAll("_", " ")}`), false);
    assert.equal(root.systemPrompt.includes(`\`${removed}\``), false);
  }
});

test("Research Agent 公开 Tavily-compatible 搜索工具", () => {
  const research = workflowAgent("research_assistant");
  assert.ok(research);
  assert.ok(research.tools.some(tool => tool.function.name === "TavilySearchTool"));
});

test("工作流在每次调用时注入动态时间与用户 Artifact 目录", () => {
  const first = workflowAgent("analyst", {
    now: new Date("2026-01-01T00:00:00.000Z"),
    artifacts: [{ artifact_id: "art-1", title: "需求说明", file_name: "requirements.pdf", extension: "pdf" }],
    newArtifacts: [{ artifact_id: "art-1", title: "需求说明", file_name: "requirements.pdf", extension: "pdf" }]
  });
  const second = workflowAgent("analyst", { now: new Date("2026-01-02T00:00:00.000Z") });
  assert.match(first.systemPrompt, /2026-01-01T00:00:00\.000Z/);
  assert.match(first.systemPrompt, /requirements\.pdf/);
  assert.doesNotMatch(first.systemPrompt, /\{\{CURRENT_TIME\}\}/);
  assert.notEqual(first.promptHash, second.promptHash);
});

test("Intention Layer 固定低延迟模型，回答模型保持独立可配置", () => {
  const status = workflowStatus();
  assert.equal(status.models.intentAlias, "intention-fast");
  assert.equal(status.models.specialistAlias, "gpt-5-4-mini");
  assert.deepEqual(status.models.automaticSelection, {
    modeId: "model-router",
    resolvedBy: "model-router",
    strategy: "hybrid-score",
    scoringWeights: { policyPriority: 0.55, reliability: 0.25, latency: 0.2 },
    minimumObservations: 4,
    circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    explorationEnabled: false
  });
  assert.equal(status.models.selectableCount, 16);
  assert.ok(workflowAgent("copilot").directResponsePrompt);
  assert.equal(status.deployment.profileId, "llm-primary");
  assert.equal(status.searchDeployment.profileId, "search-primary");
  assert.equal(status.searchDeployment.credentialRef, "WEB_SEARCH_API_KEY");
  assert.equal(status.routing.intentVersion, "intent-routing.v2");
  assert.equal(status.routing.agentVersion, "agent-routing.v2");
  assert.equal(status.routing.modelVersion, "model-routing.v3");
  assert.equal(status.routing.deploymentVersion, "deployment-routing.v2");
});
