import { agentRegistry } from "../../agents/registry.mjs";
import { validateRuntimeEvents } from "../../runtime-events.mjs";

const ROOT_AGENT_ID = agentRegistry.rootAgentId;

function result(scopeId, evaluator, status, reason, { severity = "blocking", score = status === "pass" ? 1 : 0, evidence = null } = {}) {
  return {
    scopeId,
    evaluator,
    evaluatorVersion: "1.0.0",
    severity,
    status,
    score,
    reason,
    evidence
  };
}

function check(scopeId, evaluator, condition, passReason, failReason, options = {}) {
  return result(scopeId, evaluator, condition ? "pass" : "fail", condition ? passReason : failReason, options);
}

function toolEvents(execution) {
  return (execution.result?.runtime || []).filter(event => event.kind === "TOOL CALL");
}

function normalizeToolSignature(event) {
  const sorted = value => {
    if (Array.isArray(value)) return value.map(sorted);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  };
  return `${event.name}:${JSON.stringify(sorted(event.input || {}))}`;
}

function languageMatches(answer, language) {
  if (!language) return true;
  const hasHan = /[\p{Script=Han}]/u.test(answer);
  if (String(language).toLowerCase().startsWith("zh")) return hasHan;
  if (String(language).toLowerCase().startsWith("en")) return /[A-Za-z]/u.test(answer) && !hasHan;
  return true;
}

function parentContract(runtime) {
  const byId = new Map(runtime.map(event => [event.id, event]));
  const failures = [];
  for (const event of runtime) {
    const parent = event.parentId ? byId.get(event.parentId) : null;
    if (event.kind === "CHAIN" && event.parentId !== null) failures.push(`${event.name} CHAIN 必须是根节点`);
    if (event.kind === "AGENT RUN" && event.name === `agent_run [${ROOT_AGENT_ID}]` && parent?.kind !== "CHAIN") failures.push("Root Agent 必须是 CHAIN 的子节点");
    if (event.kind === "AGENT RUN" && event.name !== `agent_run [${ROOT_AGENT_ID}]` && parent?.kind !== "AGENT RUN") failures.push(`${event.name} 必须是所属 Agent 的子节点`);
    if (event.kind === "TOOL CALL" && parent?.kind !== "AGENT RUN") failures.push(`${event.name} Tool 必须是 Agent 的子节点`);
    if (event.kind === "SPAN" && event.name === "call_llm" && parent?.kind !== "AGENT RUN") failures.push("call_llm 必须是 Agent 的子节点");
    if (event.kind === "GENERATION" && parent?.kind !== "SPAN") failures.push(`${event.name} Generation 必须是 call_llm Span 的子节点`);
    if (event.kind === "SPAN" && event.name === "handle_context_caching" && parent?.kind !== "GENERATION") failures.push("上下文缓存 Span 必须是 Generation 的子节点");
    if (event.parentId && !parent) failures.push(`${event.name} 缺少父节点 ${event.parentId}`);
  }
  return failures;
}

function modelContract(runtime) {
  const failures = [];
  for (const event of runtime.filter(candidate => candidate.kind === "GENERATION")) {
    const configured = event.input?.model_parameters?.configured_model;
    if (!configured) failures.push(`${event.name}：缺少 configured_model`);
    if (!event.input?.model_parameters?.logical_model_alias) failures.push(`${event.name}：缺少 logical_model_alias`);
    if (!event.input?.model_parameters?.model_selection_mode) failures.push(`${event.name}：缺少 model_selection_mode`);
    if (!event.metadata?.modelPolicyId) failures.push(`${event.name}：缺少 modelPolicyId`);
    if (!event.metadata?.deploymentProfileId) failures.push(`${event.name}：缺少 deploymentProfileId`);
  }
  return failures;
}

function configuredModel(event) {
  return event?.input?.model_parameters?.configured_model || event?.actor || null;
}

function requestAttachmentModalities(records) {
  const modalities = new Set();
  for (const call of records.modelCalls || []) {
    for (const message of call.request?.messages || []) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part?.type === "image_url") modalities.add("image");
        if (part?.type === "file") modalities.add("file");
        if (part?.type === "input_audio") modalities.add("audio");
      }
    }
  }
  return [...modalities].sort();
}

function historyContract(execution) {
  const history = execution.input.history;
  if (!history.length) return [];
  const rootGeneration = execution.result.runtime.find(event => event.kind === "GENERATION" && event.semanticRole === "intent-routing");
  const messages = rootGeneration?.input?.messages || [];
  return history.filter(expected => !messages.some(actual => actual.role === expected.role && actual.content === expected.content));
}

export function evaluateScenario(execution) {
  const { item, error } = execution;
  const scopeId = item.id;
  const checks = [];
  const expectedError = item.expected.error;
  if (expectedError) {
    checks.push(check(
      scopeId,
      "expected_error_contract",
      Boolean(error) && (!expectedError.code || error.code === expectedError.code),
      `收到了预期错误 ${error?.code || error?.name || "error"}。`,
      error ? `预期错误 ${expectedError.code || "任意错误"}，实际收到 ${error.code || error.name}。` : "预期执行失败，但实际执行成功。",
      { evidence: error ? { name: error.name, code: error.code, message: error.message } : null }
    ));
    if (Array.isArray(execution.records.memoryWrites)) checks.push(check(scopeId, "failed_turn_not_memorized", execution.records.memoryWrites.length === 0, "失败 Turn 未写入长期记忆。", "失败 Turn 错误写入了长期记忆。"));
    return checks;
  }

  if (error) {
    checks.push(result(scopeId, "scenario_execution", "error", error.message, {
      evidence: { name: error.name, code: error.code || null, stack: error.stack?.split("\n").slice(0, 4) }
    }));
    return checks;
  }

  const actual = execution.result;
  const runtime = actual.runtime || [];
  const tools = toolEvents(execution);
  const toolNames = tools.map(event => event.name);
  const answer = String(actual.answer || "");
  const live = execution.mode === "live";
  const expectedRoute = item.expected.route || {};
  const routeDecision = actual.routing?.agent?.decision || {};
  const observedIntent = actual.routing?.intent || actual.intent || {};
  const actualMode = routeDecision.mode === "delegate" || (actual.specialist && actual.specialist !== ROOT_AGENT_ID) ? "delegate" : "direct";
  const actualAgentId = routeDecision.agentId || (actual.specialist === ROOT_AGENT_ID ? null : actual.specialist);

  checks.push(check(scopeId, "answer_nonempty", answer.trim().length > 0, "最终答案非空。", "最终答案为空。"));
  if (typeof item.expected.memory?.write === "boolean" && Array.isArray(execution.records.memoryWrites)) {
    const expectedWrites = item.expected.memory.write ? 1 : 0;
    checks.push(check(
      scopeId,
      "memory_write_policy",
      execution.records.memoryWrites.length === expectedWrites,
      item.expected.memory.write ? "可复用信息已写入长期记忆。" : "瞬时对话未写入长期记忆。",
      `预期写入 ${expectedWrites} 条长期记忆，实际写入 ${execution.records.memoryWrites.length} 条。`
    ));
  }
  const memoryCaptureSpans = runtime.filter(event => event.kind === "SPAN" && event.semanticRole === "memory-write");
  checks.push(check(
    scopeId,
    "memory_capture_trace",
    memoryCaptureSpans.length === 1,
    "Trace 包含唯一的长期记忆决策 Span。",
    `预期 1 个长期记忆决策 Span，实际为 ${memoryCaptureSpans.length} 个。`,
    { evidence: memoryCaptureSpans.map(event => ({ id: event.id, status: event.status, output: event.output })) }
  ));
  for (const field of ["action", "reason", "kind"]) {
    if (item.expected.memory?.[field] === undefined) continue;
    checks.push(check(
      scopeId,
      `memory_${field}_contract`,
      actual.memory?.[field] === item.expected.memory[field],
      `记忆决策 ${field} 符合 ${item.expected.memory[field]}。`,
      `记忆决策 ${field} 预期为 ${item.expected.memory[field]}，实际为 ${actual.memory?.[field] ?? "缺失"}。`,
      { evidence: actual.memory || null }
    ));
  }
  checks.push(check(scopeId, "runtime_terminal_state", runtime.length > 0 && runtime.every(event => event.status !== "running"), "所有运行事件都已进入终态。", "Runtime 没有事件或仍包含运行中的 Observation。"));
  checks.push(check(scopeId, "result_identity", actual.sessionId === execution.input.sessionId && actual.requestId === execution.input.requestId, "结果保留了 Session 与 Request Identity。", "结果 Identity 与请求不一致。"));

  if (expectedRoute.mode) checks.push(check(scopeId, "route_mode_exact", actualMode === expectedRoute.mode, `路由模式为 ${actualMode}。`, `预期 ${expectedRoute.mode}，实际 ${actualMode}。`, { evidence: { actualMode, agentId: actualAgentId } }));
  const expectedAgentId = expectedRoute.agentId ?? expectedRoute.specialist;
  if (expectedAgentId !== undefined) checks.push(check(scopeId, "route_target_exact", actualAgentId === expectedAgentId, `已选择 ${expectedAgentId || "copilot 直接回答"}。`, `预期 ${expectedAgentId || "copilot 直接回答"}，实际 ${actualAgentId || "direct"}。`));

  const expectedIntent = item.expected.intent || {};
  const intentFields = [
    ["domain", "domain"],
    ["task_type", "taskType"]
  ];
  for (const [expectedField, actualField] of intentFields) {
    if (expectedIntent[expectedField] === undefined) continue;
    checks.push(check(
      scopeId,
      `intent_${expectedField}_exact`,
      observedIntent[actualField] === expectedIntent[expectedField],
      `Intent ${expectedField} 为 ${expectedIntent[expectedField]}。`,
      `Intent ${expectedField} 预期为 ${expectedIntent[expectedField]}，实际为 ${observedIntent[actualField] ?? "缺失"}。`,
      { evidence: observedIntent }
    ));
  }
  if (expectedIntent.risk !== undefined) checks.push(check(
    scopeId,
    "intent_risk_exact",
    observedIntent.risk?.level === expectedIntent.risk,
    `Intent 风险等级为 ${expectedIntent.risk}。`,
    `Intent 风险等级预期为 ${expectedIntent.risk}，实际为 ${observedIntent.risk?.level ?? "缺失"}。`,
    { evidence: observedIntent.risk || null }
  ));
  if (expectedIntent.requires_fresh_data !== undefined) checks.push(check(
    scopeId,
    "intent_freshness_exact",
    observedIntent.constraints?.requiresFreshData === expectedIntent.requires_fresh_data,
    `Intent 实时性要求为 ${expectedIntent.requires_fresh_data}。`,
    `Intent 实时性要求预期为 ${expectedIntent.requires_fresh_data}，实际为 ${observedIntent.constraints?.requiresFreshData ?? "缺失"}。`,
    { evidence: observedIntent.constraints || null }
  ));
  if (expectedIntent.requested_format !== undefined) checks.push(check(
    scopeId,
    "intent_requested_format_exact",
    observedIntent.constraints?.requestedFormat === expectedIntent.requested_format,
    `Intent 请求格式为 ${expectedIntent.requested_format}。`,
    `Intent 请求格式预期为 ${expectedIntent.requested_format}，实际为 ${observedIntent.constraints?.requestedFormat ?? "缺失"}。`,
    { evidence: observedIntent.constraints || null }
  ));
  for (const capability of expectedIntent.required_capabilities || []) checks.push(check(
    scopeId,
    `intent_required_capability:${capability}`,
    (observedIntent.requiredCapabilities || []).includes(capability),
    `Intent 保留必需能力 ${capability}。`,
    `Intent 缺少必需能力 ${capability}。`,
    { evidence: observedIntent.requiredCapabilities || [] }
  ));

  for (const name of item.expected.tools?.required || []) checks.push(check(scopeId, `tool_required_present:${name}`, toolNames.includes(name), `已调用 ${name}。`, `未调用 ${name}。`, { evidence: toolNames }));
  for (const name of item.expected.tools?.forbidden || []) checks.push(check(scopeId, `tool_forbidden_absent:${name}`, !toolNames.includes(name), `未调用 ${name}。`, `意外调用了 ${name}。`, { evidence: toolNames }));
  for (const name of item.expected.tools?.require_success || []) {
    const matching = tools.filter(event => event.name === name);
    checks.push(check(scopeId, `tool_success:${name}`, matching.length > 0 && matching.every(event => event.status === "completed"), `${name} 执行成功。`, `${name} 缺失或返回错误。`, { severity: item.expected.tools?.success_severity || "blocking", evidence: matching.map(event => ({ status: event.status, output: event.output })) }));
  }
  for (const name of item.expected.tools?.require_error || []) {
    const matching = tools.filter(event => event.name === name);
    checks.push(check(scopeId, `tool_error:${name}`, matching.length > 0 && matching.every(event => event.status === "error"), `${name} 按预期返回了结构化错误。`, `${name} 缺失或没有进入错误状态。`, { evidence: matching.map(event => ({ status: event.status, output: event.output, metadata: event.metadata })) }));
  }
  if (item.expected.tools?.forbid_duplicates) {
    const signatures = tools.map(normalizeToolSignature);
    const duplicates = signatures.filter((signature, index) => signatures.indexOf(signature) !== index);
    checks.push(check(scopeId, "duplicate_tool_calls_absent", duplicates.length === 0, "没有重复的规范化工具调用。", `检测到重复工具调用：${[...new Set(duplicates)].join(", ")}。`, { severity: item.expected.tools.duplicate_severity || "blocking", evidence: signatures }));
  }

  const response = item.expected.response || {};
  if (response.language) checks.push(check(scopeId, "answer_language", languageMatches(answer, response.language), `答案符合 ${response.language} 语言要求。`, `答案不符合 ${response.language} 语言要求。`));
  if (response.min_chars !== undefined) checks.push(check(scopeId, "answer_minimum_length", answer.length >= response.min_chars, `答案包含 ${answer.length} 个字符。`, `答案包含 ${answer.length} 个字符，至少需要 ${response.min_chars} 个。`));
  if (response.max_chars !== undefined) checks.push(check(scopeId, "answer_maximum_length", answer.length <= response.max_chars, `答案包含 ${answer.length} 个字符，未超过 ${response.max_chars}。`, `答案包含 ${answer.length} 个字符，超过上限 ${response.max_chars}。`));
  const semanticLiteral = Boolean(response.reference_answer || item.input.search_results || item.input.search_answer);
  const literalSeverity = live && semanticLiteral ? "diagnostic" : "blocking";
  for (const token of response.must_include || []) checks.push(check(scopeId, `answer_contains:${token}`, answer.includes(token), `答案包含必需内容 ${token}。`, `答案缺少必需内容 ${token}。`, { severity: literalSeverity }));
  for (const token of response.must_not_include || []) checks.push(check(scopeId, `answer_excludes:${token}`, !answer.includes(token), `答案不包含禁止内容 ${token}。`, `答案包含了禁止内容 ${token}。`));
  if (response.format === "json") {
    let valid = false;
    let parsedJson = null;
    try { parsedJson = JSON.parse(answer); valid = Boolean(parsedJson); } catch { valid = false; }
    checks.push(check(scopeId, "answer_json_valid", valid, "答案是有效 JSON。", "答案不是有效 JSON。"));
    if (Array.isArray(response.required_json_keys)) {
      const missingKeys = response.required_json_keys.filter(key => !parsedJson || typeof parsedJson !== "object" || !Object.hasOwn(parsedJson, key));
      checks.push(check(
        scopeId,
        "answer_json_required_keys",
        valid && missingKeys.length === 0,
        `JSON 包含必需字段 ${response.required_json_keys.join("、")}。`,
        `JSON 缺少必需字段 ${missingKeys.join("、") || "无法解析"}。`,
        { evidence: { requiredKeys: response.required_json_keys, missingKeys } }
      ));
    }
  }
  if (response.answer_pattern) {
    const pattern = new RegExp(response.answer_pattern, "u");
    checks.push(check(scopeId, "answer_pattern", pattern.test(answer), "答案符合确定性模式。", `答案不符合模式 ${response.answer_pattern}。`));
  }
  if (response.exact_line_count !== undefined) {
    const lineCount = answer.split(/\r?\n/u).filter(line => line.trim()).length;
    checks.push(check(scopeId, "answer_exact_line_count", lineCount === response.exact_line_count, `答案包含 ${lineCount} 个非空行。`, `预期 ${response.exact_line_count} 个非空行，实际为 ${lineCount} 个。`));
  }
  if (response.exact_bullet_count !== undefined) {
    const bulletCount = answer.split(/\r?\n/u).filter(line => /^\s*[-*]\s+/u.test(line)).length;
    checks.push(check(scopeId, "answer_exact_bullet_count", bulletCount === response.exact_bullet_count, `答案包含 ${bulletCount} 个项目符号。`, `预期 ${response.exact_bullet_count} 个项目符号，实际为 ${bulletCount} 个。`));
  }

  const performanceExpectation = item.expected.performance || {};
  const harness = actual.harness || {};
  const performanceBudgets = [
    ["max_model_calls", "modelCalls", "performance_model_call_budget"],
    ["max_tool_proposals", "toolProposals", "performance_tool_proposal_budget"],
    ["max_tool_executions", "toolExecutions", "performance_tool_execution_budget"]
  ];
  for (const [expectedField, actualField, evaluator] of performanceBudgets) {
    if (performanceExpectation[expectedField] === undefined) continue;
    const observed = Number(harness[actualField]);
    checks.push(check(
      scopeId,
      evaluator,
      Number.isFinite(observed) && observed <= performanceExpectation[expectedField],
      `${actualField} 为 ${observed}，预算上限为 ${performanceExpectation[expectedField]}。`,
      `${actualField} 为 ${Number.isFinite(observed) ? observed : "缺失"}，超过或无法验证预算 ${performanceExpectation[expectedField]}。`,
      { evidence: harness }
    ));
  }
  if (performanceExpectation.max_search_calls !== undefined) {
    const observed = tools.filter(event => event.name === "TavilySearchTool").length;
    checks.push(check(
      scopeId,
      "performance_search_call_budget",
      observed <= performanceExpectation.max_search_calls,
      `Search 调用为 ${observed}，预算上限为 ${performanceExpectation.max_search_calls}。`,
      `Search 调用为 ${observed}，超过预算 ${performanceExpectation.max_search_calls}。`,
      { evidence: tools.filter(event => event.name === "TavilySearchTool").map(event => event.id) }
    ));
  }
  const generationsForBudget = runtime.filter(event => event.kind === "GENERATION");
  if (performanceExpectation.max_total_tokens !== undefined) {
    const observed = generationsForBudget.reduce((sum, event) => sum + Number(event.output?.usage?.total || event.output?.usage?.total_tokens || 0), 0);
    checks.push(check(
      scopeId,
      "performance_total_token_budget",
      observed <= performanceExpectation.max_total_tokens,
      `总 Token 为 ${observed}，预算上限为 ${performanceExpectation.max_total_tokens}。`,
      `总 Token 为 ${observed}，超过预算 ${performanceExpectation.max_total_tokens}。`,
      { evidence: generationsForBudget.map(event => ({ id: event.id, usage: event.output?.usage || null })) }
    ));
  }
  if (performanceExpectation.max_context_messages !== undefined) {
    const rootGeneration = generationsForBudget.find(event => event.semanticRole === "intent-routing");
    const observed = Array.isArray(rootGeneration?.input?.messages) ? rootGeneration.input.messages.length : Number.NaN;
    checks.push(check(
      scopeId,
      "performance_context_message_budget",
      Number.isFinite(observed) && observed <= performanceExpectation.max_context_messages,
      `根上下文包含 ${observed} 条消息，预算上限为 ${performanceExpectation.max_context_messages}。`,
      `根上下文包含 ${Number.isFinite(observed) ? observed : "未知"} 条消息，超过或无法验证预算 ${performanceExpectation.max_context_messages}。`,
      { evidence: { observed, maximum: performanceExpectation.max_context_messages } }
    ));
  }
  if (performanceExpectation.live_e2e_budget_ms !== undefined && Number.isFinite(execution.wallTimeMs)) checks.push(check(
    scopeId,
    "performance_live_e2e_budget",
    execution.wallTimeMs <= performanceExpectation.live_e2e_budget_ms,
    `真实 E2E 为 ${Math.round(execution.wallTimeMs)} ms，预算为 ${performanceExpectation.live_e2e_budget_ms} ms。`,
    `真实 E2E 为 ${Math.round(execution.wallTimeMs)} ms，超过预算 ${performanceExpectation.live_e2e_budget_ms} ms。`,
    { severity: "diagnostic", evidence: { wallTimeMs: execution.wallTimeMs, budgetMs: performanceExpectation.live_e2e_budget_ms } }
  ));
  if (item.expected.artifacts?.generated_count !== undefined) {
    const count = Array.isArray(actual.artifacts) ? actual.artifacts.length : 0;
    checks.push(check(scopeId, "generated_artifact_count", count === item.expected.artifacts.generated_count, `生成了预期的 ${count} 个 Artifact。`, `预期生成 ${item.expected.artifacts.generated_count} 个 Artifact，实际为 ${count} 个。`, { evidence: actual.artifacts || [] }));
  }
  if (item.expected.artifacts?.input_count !== undefined) {
    const inputArtifacts = Array.isArray(actual.inputArtifacts) ? actual.inputArtifacts : [];
    checks.push(check(
      scopeId,
      "input_artifact_count",
      inputArtifacts.length === item.expected.artifacts.input_count,
      `模型输入包含预期的 ${inputArtifacts.length} 个附件。`,
      `预期 ${item.expected.artifacts.input_count} 个输入附件，实际为 ${inputArtifacts.length} 个。`,
      { evidence: inputArtifacts }
    ));
    const unsafeFields = inputArtifacts.filter(artifact => ["content", "data", "base64", "buffer"].some(field => artifact?.[field] !== undefined));
    checks.push(check(
      scopeId,
      "input_artifact_metadata_only",
      unsafeFields.length === 0,
      "结果只保留附件元数据。",
      "结果包含附件原始内容或二进制字段。",
      { evidence: unsafeFields }
    ));
  }
  if (Array.isArray(item.expected.artifacts?.required_modalities)) {
    const actualModalities = requestAttachmentModalities(execution.records);
    const missingModalities = item.expected.artifacts.required_modalities.filter(modality => !actualModalities.includes(modality));
    checks.push(check(
      scopeId,
      "multimodal_request_contract",
      missingModalities.length === 0,
      `模型请求包含 ${item.expected.artifacts.required_modalities.join("、")} 输入。`,
      `模型请求缺少 ${missingModalities.join("、")} 输入。`,
      { evidence: actualModalities }
    ));
    const traceText = JSON.stringify(runtime);
    checks.push(check(
      scopeId,
      "multimodal_trace_redaction",
      !traceText.includes(";base64,") && !traceText.includes("data:image/") && !traceText.includes("data:application/pdf"),
      "应用 Runtime Trace 未持久化附件 Base64。",
      "应用 Runtime Trace 泄漏了附件 Base64。"
    ));
  }

  const requiredKinds = item.expected.trace?.required_kinds || ["CHAIN", "AGENT RUN", "SPAN", "GENERATION"];
  for (const kind of requiredKinds) checks.push(check(scopeId, `trace_kind_present:${kind}`, runtime.some(event => event.kind === kind), `Trace 包含 ${kind}。`, `Trace 缺少 ${kind}。`));
  const parentFailures = parentContract(runtime);
  checks.push(check(scopeId, "trace_parent_contract", parentFailures.length === 0, "Trace 父子层级有效。", parentFailures.join("；"), { evidence: parentFailures }));
  const intentionGenerations = runtime.filter(event => event.kind === "GENERATION" && event.semanticRole === "intent-routing");
  const answerGenerations = runtime.filter(event => event.kind === "GENERATION" && ["direct-response", "specialist-response"].includes(event.semanticRole));
  const intentRoutes = runtime.filter(event => event.kind === "SPAN" && event.semanticRole === "intent-routing-decision");
  const agentRoutes = runtime.filter(event => event.kind === "SPAN" && event.semanticRole === "agent-routing");
  const modelRoutes = runtime.filter(event => event.kind === "SPAN" && event.semanticRole === "model-routing");
  const answerModelRoutes = modelRoutes.filter(event => ["direct", "specialist"].includes(event.output?.role));
  const deploymentRoutes = runtime.filter(event => event.kind === "SPAN" && event.semanticRole === "deployment-routing");
  const modelDeploymentRoutes = deploymentRoutes.filter(event => event.output?.workload === "llm");
  const searchDeploymentRoutes = deploymentRoutes.filter(event => event.output?.workload === "search");
  const generations = runtime.filter(event => event.kind === "GENERATION");
  const unresolvedModelRoutes = modelRoutes.filter(event => !event.output?.modelAlias || event.output.modelAlias === "model-router");
  checks.push(check(
    scopeId,
    "model_route_resolves_concrete_alias",
    unresolvedModelRoutes.length === 0,
    "Model Router 为每次 Generation 选择了具体逻辑模型。",
    "Model Route 仍包含选择模式或缺失具体逻辑模型。",
    { evidence: unresolvedModelRoutes.map(event => event.output) }
  ));
  const incompleteDecisionEvidence = modelRoutes.filter(event => (
    event.output?.schemaVersion !== "copilot-model-route.v3"
    || !Array.isArray(event.output?.candidateModelAliases)
    || !event.output.candidateModelAliases.includes(event.output?.modelAlias)
    || !Array.isArray(event.output?.candidateEvaluation)
    || !Array.isArray(event.output?.rankedCandidateAliases)
    || event.output.candidateEvaluation.some(candidate => !candidate.scoreBreakdown || !candidate.runtimeEvidence)
    || !Array.isArray(event.output?.requiredModalities)
    || !event.output?.selectionMode
    || !event.output?.selectionReasonCode
  ));
  checks.push(check(
    scopeId,
    "model_route_decision_evidence",
    incompleteDecisionEvidence.length === 0,
    "Model Route 保留了候选、模态、策略和选择原因。",
    "Model Route 缺少可复现的模型选择证据。",
    { evidence: incompleteDecisionEvidence.map(event => event.output) }
  ));
  if (!item.input.model || item.input.model === "model-router") {
    const invalidAutomaticRoutes = answerModelRoutes.filter(event => event.output?.selectionMode !== "model-router" || event.output?.selectionSource !== "policy-and-runtime-evidence");
    checks.push(check(
      scopeId,
      "model_router_mode_owned_by_application",
      answerModelRoutes.length > 0 && invalidAutomaticRoutes.length === 0,
      "默认选择由应用 Model Router 解析，回答链路未依赖网关级动态模型。",
      "默认回答链路没有由应用 Model Router 完成模型选择。",
      { evidence: answerModelRoutes.map(event => event.output) }
    ));
  }
  checks.push(check(scopeId, "intention_generation_present", intentionGenerations.length > 0, "Trace 包含根 Agent 意图识别 Generation。", "Trace 缺少根 Agent 意图识别 Generation。", { evidence: intentionGenerations.map(event => event.id) }));
  if (item.expected.models?.intention_alias) {
    const actualAliases = modelRoutes
      .filter(event => event.output?.role === "intent")
      .map(event => event.output?.modelAlias);
    checks.push(check(
      scopeId,
      "intention_model_alias_exact",
      actualAliases.length > 0 && actualAliases.every(alias => alias === item.expected.models.intention_alias),
      `Intention Layer 固定使用逻辑模型 ${item.expected.models.intention_alias}。`,
      `Intention Layer 预期使用 ${item.expected.models.intention_alias}，实际为 ${actualAliases.join(", ") || "缺失"}。`,
      { evidence: actualAliases }
    ));
  }
  if (item.expected.models?.answer_alias) {
    const actualAliases = modelRoutes
      .filter(event => ["direct", "specialist"].includes(event.output?.role))
      .map(event => event.output?.modelAlias);
    checks.push(check(
      scopeId,
      "answer_model_alias_exact",
      actualAliases.length > 0 && actualAliases.every(alias => alias === item.expected.models.answer_alias),
      `用户可见答案使用逻辑模型 ${item.expected.models.answer_alias}。`,
      `答案模型预期为 ${item.expected.models.answer_alias}，实际为 ${actualAliases.join(", ") || "缺失"}。`,
      { evidence: actualAliases }
    ));
  }
  if (item.input.model && item.input.model !== "model-router") {
    const intentModels = intentionGenerations.map(configuredModel);
    const answerModels = answerGenerations.map(configuredModel);
    const intentAliases = modelRoutes.filter(event => event.output?.role === "intent").map(event => event.output?.modelAlias);
    const answerAliases = modelRoutes.filter(event => ["direct", "specialist"].includes(event.output?.role)).map(event => event.output?.modelAlias);
    checks.push(check(
      scopeId,
      "response_model_isolated_from_intention",
      intentModels.length > 0 && answerModels.length > 0 && actual.model === item.input.model
        && (!item.expected.models?.intention_alias || intentAliases.every(alias => alias === item.expected.models.intention_alias))
        && answerAliases.every(alias => alias === item.input.model),
      "回答模型选择没有覆盖 Intention Layer 模型。",
      "回答模型选择污染了 Intention Layer，或结果未保留逻辑模型 ID。",
      { evidence: { selectedModelId: actual.model, intentAliases, answerAliases, intentModels, answerModels } }
    ));
  }
  checks.push(check(scopeId, "intent_route_correlated", intentRoutes.length === intentionGenerations.length && intentRoutes.length > 0, "每次根意图 Generation 都有独立 Intent Route。", `根意图 Generation 为 ${intentionGenerations.length} 个，Intent Route 为 ${intentRoutes.length} 个。`, { evidence: intentRoutes.map(event => event.output) }));
  checks.push(check(scopeId, "agent_route_correlated", agentRoutes.length === intentionGenerations.length && agentRoutes.length > 0, "每次 Intent Route 都有独立 Agent Route。", `根意图 Generation 为 ${intentionGenerations.length} 个，Agent Route 为 ${agentRoutes.length} 个。`, { evidence: agentRoutes.map(event => event.output) }));
  checks.push(check(scopeId, "model_route_correlated", modelRoutes.length === generations.length && modelRoutes.length > 0, "每次 Generation 都有独立 Model Route。", `Generation 为 ${generations.length} 个，Model Route 为 ${modelRoutes.length} 个。`, { evidence: modelRoutes.map(event => event.output) }));
  checks.push(check(scopeId, "deployment_route_correlated", modelDeploymentRoutes.length === generations.length && modelDeploymentRoutes.length > 0, "每次 Generation 都有独立 LLM Deployment Route。", `Generation 为 ${generations.length} 个，LLM Deployment Route 为 ${modelDeploymentRoutes.length} 个。`, { evidence: modelDeploymentRoutes.map(event => event.output) }));
  const searchTools = tools.filter(event => event.name === "TavilySearchTool");
  if (searchTools.length) {
    checks.push(check(scopeId, "search_deployment_route_correlated", searchDeploymentRoutes.length === searchTools.length, "每次搜索执行都有独立 Search Deployment Route。", `搜索 Tool 为 ${searchTools.length} 个，Search Deployment Route 为 ${searchDeploymentRoutes.length} 个。`, { evidence: searchDeploymentRoutes.map(event => event.output) }));
  }
  if (actualMode === "delegate") {
    const specialistAgent = runtime.find(event => event.kind === "AGENT RUN" && event.name === `agent_run [${actual.specialist}]`);
    const specialistGenerations = runtime.filter(event => event.kind === "GENERATION" && event.name === "specialist-response");
    checks.push(check(scopeId, "specialist_trace_present", Boolean(specialistAgent) && specialistGenerations.length > 0, "Trace 包含被委派 Specialist 及其模型 Generation。", "Trace 缺少被委派 Specialist 或其模型 Generation。", { evidence: { specialistAgent: specialistAgent?.id || null, specialistGenerations: specialistGenerations.map(event => event.id) } }));
  }
  const missingToolCallIds = tools.filter(event => !event.metadata?.toolCallId).map(event => event.id);
  checks.push(check(scopeId, "tool_call_correlation", missingToolCallIds.length === 0, "所有真实 Tool Span 都保留了 Tool Call ID。", `${missingToolCallIds.length} 个 Tool Span 缺少 Tool Call ID。`, { evidence: missingToolCallIds }));
  const runtimeContract = validateRuntimeEvents(runtime);
  checks.push(check(scopeId, "runtime_event_contract", runtimeContract.valid, "运行事件符合 copilot-runtime-event.v1 协议。", runtimeContract.errors.join("; "), { evidence: runtimeContract.errors }));
  const modelFailures = modelContract(runtime);
  checks.push(check(scopeId, "model_policy", modelFailures.length === 0, "Generation 模型符合角色配置策略。", modelFailures.join("；"), { evidence: modelFailures }));
  const missingHistory = historyContract(execution);
  checks.push(check(scopeId, "history_preserved", missingHistory.length === 0, "所有有界 History 都已进入根 Agent 上下文。", `缺少 ${missingHistory.length} 条 History 消息。`, { evidence: missingHistory }));

  if (item.expected.search?.query_contains) {
    const queries = execution.records.searchCalls?.map(call => call.query)
      || tools.filter(event => event.name === "TavilySearchTool").map(event => String(event.input?.query || ""));
    checks.push(check(scopeId, "search_query_contract", queries.some(query => query.includes(item.expected.search.query_contains)), "搜索 Query 包含必需意图词。", `没有搜索 Query 包含 ${item.expected.search.query_contains}。`, { evidence: queries }));
  }
  return checks;
}
