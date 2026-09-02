import assert from "node:assert/strict";
import test from "node:test";

import {
  createRoutingSystem,
  loadRoutingConfiguration
} from "../routing/index.mjs";
import { modelCatalog } from "../model-catalog.mjs";

const agents = [
  { id: "copilot", routable: true, capabilities: ["transfer_to_agent", "load_memory"] },
  { id: "medical_assistant", routable: true, capabilities: ["TavilySearchTool"] },
  { id: "research_assistant", routable: true, capabilities: ["TavilySearchTool"] },
  { id: "teaching_assistant", routable: true, capabilities: [] },
  { id: "software_development_assistant", routable: true, capabilities: ["TavilySearchTool"] },
  { id: "analyst", routable: true, capabilities: [] },
  { id: "document_generator_assistant", routable: true, capabilities: ["generate_pdf", "generate_docx"] }
];

const modelRoutingOptions = {
  selectableModelAliases: modelCatalog.models.filter(model => model.kind === "answer-model").map(model => model.modelAlias),
  selectionModeAliases: modelCatalog.models.filter(model => model.kind === "selection-mode").map(model => model.modelAlias),
  modelDescriptors: modelCatalog.models.filter(model => model.kind !== "selection-mode")
};

test("四层路由分别输出稳定、可审计的配置决策", () => {
  const configuration = loadRoutingConfiguration();
  const routing = createRoutingSystem({
    configuration,
    agents,
    environment: {
      LLM_GATEWAY_API_KEY: "test-secret",
      LLM_GATEWAY_BASE_URL: "https://gateway.example/v1",
      WEB_SEARCH_API_KEY: "test-search-secret",
      WEB_SEARCH_BASE_URL: "https://search.example/v1/tavily"
    },
    ...modelRoutingOptions
  });

  const intent = routing.intent.route({ prompt: "我头痛两天了，应该怎么办？" });
  assert.equal(intent.schemaVersion, "copilot-intent-decision.v1");
  assert.equal(intent.domain, "health");
  assert.equal(intent.risk.level, "high");

  const agent = routing.agent.route({
    intent,
    proposal: { mode: "direct", agentId: null }
  });
  assert.equal(agent.schemaVersion, "copilot-agent-route.v1");
  assert.equal(agent.decision.mode, "delegate");
  assert.equal(agent.decision.agentId, "medical_assistant");
  assert.equal(agent.policy.action, "override");

  const model = routing.model.route({ role: "specialist", intent, agentId: agent.decision.agentId });
  assert.equal(model.schemaVersion, "copilot-model-route.v3");
  assert.equal(model.policyId, "specialist-high-assurance");
  assert.equal(model.modelAlias, "gpt-5-4");
  assert.equal(model.selectionMode, "model-router");
  assert.equal(model.selectionReasonCode, "hybrid-policy-prior");

  const deployment = routing.deployment.route({ workload: "llm", modelRoute: model });
  assert.equal(deployment.schemaVersion, "copilot-deployment-route.v1");
  assert.equal(deployment.profileId, "llm-primary");
  assert.equal(deployment.model, "openai/gpt-5.4");
  assert.equal(deployment.baseUrl, "https://gateway.example/v1");
  assert.equal(JSON.stringify(deployment).includes("test-secret"), false);
  assert.equal(routing.deployment.credentials(deployment).apiKey, "test-secret");

  const searchDeployment = routing.deployment.route({ workload: "search" });
  assert.equal(searchDeployment.profileId, "search-primary");
  assert.equal(searchDeployment.baseUrl, "https://search.example/v1/tavily");
  assert.equal(searchDeployment.credentialRef, "WEB_SEARCH_API_KEY");
  assert.equal(JSON.stringify(searchDeployment).includes("test-search-secret"), false);
  assert.equal(routing.deployment.credentials(searchDeployment).apiKey, "test-search-secret");

  const intentModel = routing.model.route({ role: "intent", requestedModelAlias: "gpt-5-4-mini" });
  assert.equal(intentModel.modelAlias, "intention-fast");
  assert.equal(intentModel.selectionSource, "policy-and-runtime-evidence");
  assert.equal(routing.deployment.route({ workload: "llm", modelRoute: intentModel }).model, "google/gemini-3.1-flash-lite");

  const explicitModel = routing.model.route({ role: "direct", requestedModelAlias: "gpt-5-4-mini" });
  assert.equal(explicitModel.modelAlias, "gpt-5-4-mini");
  assert.equal(explicitModel.policyId, "user-selected");
  assert.equal(explicitModel.selectionSource, "user");
  assert.equal(routing.deployment.route({ workload: "llm", modelRoute: explicitModel }).model, "openai/gpt-5.4-mini");
});

test("路由规则完全由配置驱动，可在不修改路由代码时替换", () => {
  const configuration = structuredClone(loadRoutingConfiguration());
  const medical = configuration.intentRouting.rules.find(rule => rule.id === "medical-health-request");
  medical.output.domain = "wellness";
  const medicalRoute = configuration.agentRouting.rules.find(rule => rule.id === "medical-specialist");
  medicalRoute.targetAgentId = "teaching_assistant";

  const routing = createRoutingSystem({ configuration, agents, environment: {}, ...modelRoutingOptions });
  const intent = routing.intent.route({ prompt: "我头痛两天了，应该怎么办？" });
  const agent = routing.agent.route({ intent, proposal: { mode: "direct", agentId: null } });

  assert.equal(intent.domain, "wellness");
  assert.equal(agent.decision.agentId, "teaching_assistant");
});

test("未知 Agent 建议不会越过 Agent Registry", () => {
  const routing = createRoutingSystem({ configuration: loadRoutingConfiguration(), agents, environment: {}, ...modelRoutingOptions });
  const intent = routing.intent.route({ prompt: "你好" });
  const agent = routing.agent.route({
    intent,
    proposal: { mode: "delegate", agentId: "nonexistent_agent" }
  });

  assert.equal(agent.proposal.valid, false);
  assert.equal(agent.decision.mode, "direct");
  assert.equal(agent.policy.reasonCode, "unknown-agent");
});

test("Preferred Agent 规则确认匹配提议，并公开可配置的推荐目标", () => {
  const routing = createRoutingSystem({ configuration: loadRoutingConfiguration(), agents, environment: {}, ...modelRoutingOptions });
  const intent = routing.intent.route({ prompt: "请分析自研和采购的成本与控制力差异" });
  const agent = routing.agent.route({
    intent,
    proposal: { mode: "delegate", agentId: "analyst" }
  });

  assert.equal(agent.decision.agentId, "analyst");
  assert.equal(agent.policy.action, "confirm");
  assert.equal(agent.policy.recommendedAgentId, "analyst");
});

test("复合意图保留主任务，并聚合风险、能力与新鲜度信号", () => {
  const routing = createRoutingSystem({ configuration: loadRoutingConfiguration(), agents, environment: {}, ...modelRoutingOptions });
  const intent = routing.intent.route({ prompt: "请搜索最新指南，分析我的头痛症状并生成 PDF 报告" });

  assert.equal(intent.ruleId, "explicit-document-generation");
  assert.deepEqual(intent.matchedRuleIds.slice(0, 3), [
    "explicit-document-generation",
    "medical-health-request",
    "fresh-external-information"
  ]);
  assert.equal(intent.risk.level, "high");
  assert.equal(intent.constraints.requiresFreshData, true);
  assert.equal(intent.requiredCapabilities.includes("TavilySearchTool"), true);
  assert.equal(intent.requiredCapabilities.includes("generate_pdf"), true);
});

test("中文眼部症状进入高风险医疗策略", () => {
  const routing = createRoutingSystem({ configuration: loadRoutingConfiguration(), agents, environment: {}, ...modelRoutingOptions });
  const intent = routing.intent.route({ prompt: "我下午经常眼睛酸胀、看屏幕更明显，可能是什么原因？" });
  assert.equal(intent.domain, "health");
  assert.equal(intent.risk.level, "high");
  const route = routing.model.route({ role: "specialist", intent, agentId: "medical_assistant", requestedModelAlias: "model-router" });
  assert.equal(route.policyId, "specialist-high-assurance");
  assert.equal(route.modelAlias, "gpt-5-4");
});

test("Intention Layer 区分个人状态、数据库查询与需要外部证据的专业任务", () => {
  const routing = createRoutingSystem({ configuration: loadRoutingConfiguration(), agents, environment: {}, ...modelRoutingOptions });

  assert.equal(routing.intent.route({ prompt: "我的最新设置是以后都用简短回答。" }).constraints.requiresFreshData, false);
  assert.equal(routing.intent.route({ prompt: "前の会話で伝えた最新の状態を要約して。" }).constraints.requiresFreshData, false);

  const sql = routing.intent.route({ prompt: "写代码查询本季度最有价值客户，先确认业务指标，不要生成 SQL。" });
  assert.equal(sql.domain, "software_engineering");
  assert.equal(sql.constraints.requiresFreshData, false);

  const finance = routing.intent.route({ prompt: "根据最新年报核对营业利润率，并给出官方证据位置。" });
  const financeAgent = routing.agent.route({ intent: finance, proposal: { mode: "direct", agentId: null } });
  assert.equal(finance.domain, "finance");
  assert.equal(finance.taskType, "financial_analysis");
  assert.equal(finance.constraints.requiresFreshData, true);
  assert.equal(financeAgent.decision.agentId, "research_assistant");

  const medical = routing.intent.route({ prompt: "我胸口有压迫感并且出冷汗，现在该怎么办？" });
  assert.equal(medical.domain, "health");
  assert.equal(medical.risk.level, "high");
});

test("智能选择由 Model Router 解析为支持输入模态的具体模型", () => {
  const routing = createRoutingSystem({ configuration: loadRoutingConfiguration(), agents, environment: {}, ...modelRoutingOptions });
  const intent = routing.intent.route({ prompt: "请调试这段视频处理代码" });
  const route = routing.model.route({
    role: "specialist",
    intent,
    agentId: "software_development_assistant",
    requestedModelAlias: "model-router",
    requiredModalities: ["video"]
  });

  assert.equal(route.modelAlias, "gemini-3-1-pro-preview");
  assert.equal(route.selectionMode, "model-router");
  assert.equal(route.selectionReasonCode, "capability-fallback");
  assert.equal(route.selectedCandidateIndex, 1);
  assert.deepEqual(route.candidateEvaluation[0].missingModalities, ["video"]);
  assert.equal(routing.deployment.route({ workload: "llm", modelRoute: route }).model, "google/gemini-3.1-pro-preview");
});

test("混合路由根据真实调用延迟覆盖静态候选顺序", () => {
  const routing = createRoutingSystem({ configuration: loadRoutingConfiguration(), agents, environment: {}, ...modelRoutingOptions });
  for (let index = 0; index < 4; index += 1) {
    routing.model.observe({ modelAlias: "gpt-5-4", success: true, latencyMs: 30000 });
    routing.model.observe({ modelAlias: "gemini-3-1-pro-preview", success: true, latencyMs: 2500 });
  }
  const route = routing.model.route({
    role: "specialist",
    agentId: "software_development_assistant",
    requestedModelAlias: "model-router",
    routingKey: "routing-evidence-test"
  });
  assert.equal(route.modelAlias, "gemini-3-1-pro-preview");
  assert.equal(route.selectionReasonCode, "runtime-evidence-override");
  assert.equal(route.candidateEvaluation.every(candidate => candidate.runtimeEvidence.evidenceReady), true);
  assert.ok(route.candidateEvaluation[1].scoreBreakdown.total > route.candidateEvaluation[0].scoreBreakdown.total);
});

test("连续失败触发熔断并在冷却结束后恢复候选", () => {
  let timestamp = Date.parse("2026-09-01T00:00:00.000Z");
  const routing = createRoutingSystem({
    configuration: loadRoutingConfiguration(), agents, environment: {}, ...modelRoutingOptions,
    modelRouterNow: () => timestamp
  });
  for (let index = 0; index < 3; index += 1) {
    routing.model.observe({ modelAlias: "gpt-5-4", success: false, errorCode: "llm_upstream_error" });
  }
  const fallback = routing.model.route({
    role: "specialist",
    agentId: "software_development_assistant",
    requestedModelAlias: "model-router"
  });
  assert.equal(fallback.modelAlias, "gemini-3-1-pro-preview");
  assert.equal(fallback.selectionReasonCode, "circuit-breaker-fallback");
  assert.equal(fallback.candidateEvaluation[0].runtimeEvidence.circuitOpen, true);

  timestamp += 60_001;
  const recovered = routing.model.route({
    role: "specialist",
    agentId: "software_development_assistant",
    requestedModelAlias: "model-router"
  });
  assert.equal(recovered.modelAlias, "gpt-5-4");
  assert.equal(recovered.selectionReasonCode, "hybrid-policy-prior");
});
