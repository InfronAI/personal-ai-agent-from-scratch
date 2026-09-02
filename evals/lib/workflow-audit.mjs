function finding(evaluator, status, reason, { severity = "blocking", evidence = null } = {}) {
  return {
    scopeId: "workflow",
    evaluator,
    evaluatorVersion: "1.0.0",
    severity,
    status,
    score: status === "pass" ? 1 : 0,
    reason,
    evidence
  };
}

export function auditWorkflow({ agentWorkflow, workflowAgent, workflowStatus, executableToolNames, goldenSetStatus }) {
  const results = [];
  const rootAgentId = agentWorkflow.rootAgentId;
  const root = workflowAgent(rootAgentId);
  const status = workflowStatus();
  const transfer = root?.tools?.find(tool => tool.function?.name === "transfer_to_agent");
  const enumTargets = transfer?.function?.parameters?.properties?.agent_name?.enum || [];
  const routable = root?.routableAgents || [];

  results.push(finding("workflow_schema_supported", agentWorkflow.schemaVersion === "copilot-workflow-config.v1" ? "pass" : "fail", `工作流协议版本为 ${agentWorkflow.schemaVersion}。`));
  results.push(finding("route_enum_matches_registry", JSON.stringify(enumTargets) === JSON.stringify(routable) ? "pass" : "fail", JSON.stringify(enumTargets) === JSON.stringify(routable) ? "Transfer Enum 与可路由 Agent 注册表一致。" : "Transfer Enum 与可路由 Agent 注册表不一致。", { evidence: { enumTargets, routable } }));
  const missingRoutes = routable.filter(name => !workflowAgent(name)?.systemPrompt);
  results.push(finding("routable_agents_configured", missingRoutes.length ? "fail" : "pass", missingRoutes.length ? `以下 Agent 缺少 Prompt 或配置：${missingRoutes.join(", ")}。` : "所有可路由 Agent 都有可执行 Workflow 配置。", { evidence: missingRoutes }));
  const requiredStages = ["intent-routing", "agent-routing", "model-routing", "deployment-routing"];
  const missingStages = requiredStages.filter(stage => !status.stages.includes(stage));
  results.push(finding(
    "four_layer_routing_stages",
    missingStages.length ? "fail" : "pass",
    missingStages.length ? `Workflow 缺少路由阶段：${missingStages.join(", ")}。` : "Workflow 显式包含 Intent、Agent、Model 与 Deployment 四层路由。",
    { evidence: status.stages }
  ));
  const routeVersions = status.routing || {};
  const missingRouteVersions = ["intentVersion", "agentVersion", "modelVersion", "deploymentVersion"].filter(key => !routeVersions[key]);
  results.push(finding(
    "routing_versions_declared",
    missingRouteVersions.length ? "fail" : "pass",
    missingRouteVersions.length ? `路由配置缺少版本：${missingRouteVersions.join(", ")}。` : "四层路由均声明独立版本。",
    { evidence: routeVersions }
  ));
  const modelAliasesValid = status.models?.intentAlias && status.models?.specialistAlias;
  results.push(finding(
    "logical_model_policy_declared",
    modelAliasesValid ? "pass" : "fail",
    modelAliasesValid ? "Intent 与 Specialist 均通过逻辑 Model Policy 选择模型。" : "Model Policy 缺少角色模型别名。",
    { evidence: status.models }
  ));
  const automaticSelectionOwnedLocally = status.models?.automaticSelection?.modeId === "model-router"
    && status.models?.automaticSelection?.resolvedBy === "model-router"
    && status.models?.automaticSelection?.strategy === "hybrid-score"
    && status.models?.automaticSelection?.explorationEnabled === false
    && status.models?.specialistAlias !== "model-router";
  results.push(finding(
    "automatic_model_selection_owned_locally",
    automaticSelectionOwnedLocally ? "pass" : "fail",
    automaticSelectionOwnedLocally
      ? "默认选择模式由应用 Model Router 解析，并使用可审计的混合评分策略。"
      : "选择模式仍被当作部署模型，或缺少应用侧混合评分策略。",
    { evidence: status.models }
  ));
  const intentionModelIsolated = status.models?.intentAlias === "intention-fast"
    && Boolean(status.deployment?.model)
    && status.deployment.model !== "model-router";
  results.push(finding(
    "intention_model_default_isolated",
    intentionModelIsolated ? "pass" : "fail",
    intentionModelIsolated
      ? "Intention Layer 使用独立的具体默认模型。"
      : "Intention Layer 默认模型或逻辑别名与产品契约不一致。",
    { evidence: { intentAlias: status.models?.intentAlias || null, model: status.deployment?.model || null } }
  ));
  const selectableModelCount = Number(status.models?.selectableCount || 0);
  results.push(finding(
    "selectable_model_catalog",
    selectableModelCount === 16 ? "pass" : "fail",
    selectableModelCount === 16
      ? "服务端模型目录提供智能选择与 15 个显式模型。"
      : `服务端模型目录预期提供 16 个选项，实际为 ${selectableModelCount} 个。`,
    { evidence: status.models }
  ));
  const setupContractValid = status.setup?.onboardingVersion === "core-configuration.v4"
    && typeof status.setup?.webConfigurationEnabled === "boolean"
    && status.setup?.judgeModelEnvironmentKey === "COPILOT_EVAL_JUDGE_MODEL";
  results.push(finding(
    "first_login_setup_contract",
    setupContractValid ? "pass" : "fail",
    setupContractValid
      ? "首次登录核心配置向导声明稳定版本、明确的 Web 配置开关和独立 Judge 模型覆盖键。"
      : "首次登录核心配置向导缺少稳定版本、Web 配置边界或 Judge 模型覆盖键。",
    { evidence: status.setup || null }
  ));
  const goldenStatus = goldenSetStatus?.() || {};
  const feedbackReviewPolicyValid = goldenStatus.review_policy?.queue_status === "candidate"
    && goldenStatus.review_policy?.rejected_disposition === "audit-only";
  results.push(finding(
    "feedback_rejection_queue_contract",
    feedbackReviewPolicyValid ? "pass" : "fail",
    feedbackReviewPolicyValid
      ? "拒绝项会移出待审候选队列，同时保留独立可查询的审核记录。"
      : "反馈审核策略没有明确区分待审候选与已拒绝审计记录。",
    { evidence: goldenStatus.review_policy || null }
  ));
  const feedbackEvidencePolicyValid = goldenStatus.evidence_policy?.schema_version === "copilot-eval-evidence.v1"
    && goldenStatus.evidence_policy?.scope === "target-trace+session-prefix"
    && goldenStatus.evidence_policy?.feedback_subject === "turn"
    && goldenStatus.evidence_policy?.session_boundary === "through-evaluated-turn"
    && goldenStatus.evidence_policy?.excludes_future_turns === true
    && goldenStatus.evidence_policy?.golden_export === "self-contained";
  results.push(finding(
    "feedback_trace_session_evidence_contract",
    feedbackEvidencePolicyValid ? "pass" : "fail",
    feedbackEvidencePolicyValid
      ? "赞踩保存目标 Trace 与截止该 Turn 的 Session 证据，并随 Golden 数据自包含导出。"
      : "反馈链路未声明完整 Trace、时间点 Session 边界或自包含 Golden 导出策略。",
    { evidence: goldenStatus.evidence_policy || null }
  ));
  const deploymentValid = status.deployment?.profileId && status.deployment?.credentialRef && !JSON.stringify(status.deployment).toLowerCase().includes("secret");
  results.push(finding(
    "deployment_route_safe",
    deploymentValid ? "pass" : "fail",
    deploymentValid ? "Deployment Route 声明 Profile 与凭证引用，且状态中不包含密钥。" : "Deployment Route 缺失或泄漏凭证。",
    { evidence: status.deployment }
  ));
  const searchDeploymentValid = status.searchDeployment?.profileId === "search-primary"
    && status.searchDeployment?.credentialRef === "WEB_SEARCH_API_KEY"
    && !JSON.stringify(status.searchDeployment).toLowerCase().includes("secret");
  results.push(finding(
    "search_deployment_uses_dedicated_credential",
    searchDeploymentValid ? "pass" : "fail",
    searchDeploymentValid
      ? "Search Deployment 使用独立凭证引用，状态中不包含密钥。"
      : "Search Deployment 未使用独立凭证引用，或状态泄漏了凭证。",
    { evidence: status.searchDeployment || null }
  ));

  const executors = new Set(executableToolNames);
  const parityFailures = [];
  for (const name of [rootAgentId, ...routable]) {
    const agent = workflowAgent(name);
    for (const tool of agent?.tools || []) {
      const toolName = tool.function?.name;
      if (!executors.has(toolName)) parityFailures.push({ agent: name, tool: toolName });
    }
  }
  results.push(finding("tool_executor_parity", parityFailures.length ? "fail" : "pass", parityFailures.length ? `${parityFailures.length} 个 Agent/工具组合没有本地执行器。` : "所有对模型公开的工具都具备本地执行器。", { evidence: parityFailures }));

  const knownSchemas = new Set([...agentWorkflow.agents.values()].flatMap(agent => agent.tools.map(tool => tool.function?.name)));
  const staleReferences = [];
  for (const agent of agentWorkflow.agents.values()) {
    const promptToolReferences = [...agent.systemPrompt.matchAll(/`([A-Za-z][A-Za-z0-9_]{2,63})`/gu)]
      .map(match => match[1])
      .filter(name => name.endsWith("Tool") || /^(?:load_|generate_|transfer_)/u.test(name));
    for (const candidate of new Set(promptToolReferences)) {
      if (!knownSchemas.has(candidate)) staleReferences.push({ agent: agent.name, referencedTool: candidate });
    }
  }
  results.push(finding("prompt_tool_reference", staleReferences.length ? "fail" : "pass", staleReferences.length ? "System Prompt 引用了能力注册表中不存在的工具。" : "System Prompt 中的工具引用与能力注册表一致。", { evidence: staleReferences }));

  const staticTimes = [...agentWorkflow.agents.values()].flatMap(agent => {
    const matches = [...agent.systemPromptTemplate.matchAll(/Current Time:\s*([^\n]+)/gu)];
    return matches
      .filter(match => match[1].trim() !== "{{CURRENT_TIME}}")
      .map(match => ({ agent: agent.name, value: match[1] }));
  });
  const renderedAtStart = workflowAgent("research_assistant", { now: new Date("2026-01-01T00:00:00.000Z") })?.systemPrompt || "";
  const renderedAtEnd = workflowAgent("research_assistant", { now: new Date("2026-01-02T00:00:00.000Z") })?.systemPrompt || "";
  const dynamicTimeWorks = renderedAtStart !== renderedAtEnd && !renderedAtStart.includes("{{CURRENT_TIME}}");
  const timeStatus = !staticTimes.length && dynamicTimeWorks ? "pass" : "fail";
  results.push(finding("dynamic_runtime_time", timeStatus, timeStatus === "pass" ? "运行时会动态注入当前时间。" : "时间模板仍包含静态值，或运行时没有完成注入。", { evidence: staticTimes }));

  const active = new Set([rootAgentId, ...routable]);
  const deadAgents = [...agentWorkflow.agents.keys()].filter(name => !active.has(name));
  results.push(finding("no_dead_agent_config", deadAgents.length ? "fail" : "pass", deadAgents.length ? `仍存在不可达的 Agent 配置：${deadAgents.join(", ")}。` : "所有已配置 Agent 均可由 Root Agent 到达。", { evidence: deadAgents }));

  const duplicateTools = [];
  for (const agent of agentWorkflow.agents.values()) {
    const names = agent.tools.map(tool => tool.function?.name);
    for (const name of new Set(names.filter((candidate, index) => names.indexOf(candidate) !== index))) duplicateTools.push({ agent: agent.name, tool: name });
  }
  results.push(finding("agent_tool_names_unique", duplicateTools.length ? "fail" : "pass", duplicateTools.length ? "同一 Agent 内存在重复 Tool Schema。" : "每个 Agent 内的工具名称均唯一。", { evidence: duplicateTools }));
  return results;
}
