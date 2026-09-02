import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultPath = fileURLToPath(new URL("../config/routing.config.json", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function requireObject(value, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} 必须是对象`);
}

function requireRules(section, location) {
  requireObject(section, location);
  if (!section.version || typeof section.version !== "string") throw new Error(`${location}.version 必须是非空字符串`);
  if (!Array.isArray(section.rules)) throw new Error(`${location}.rules 必须是数组`);
  const ids = new Set();
  for (const [index, rule] of section.rules.entries()) {
    requireObject(rule, `${location}.rules[${index}]`);
    if (!rule.id || ids.has(rule.id)) throw new Error(`${location} 包含缺失或重复的规则 ID：${rule.id || "missing"}`);
    ids.add(rule.id);
  }
}

function requireString(value, location) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} 必须是非空字符串`);
}

function requireIntentOutput(value, location) {
  requireObject(value, location);
  requireString(value.domain, `${location}.domain`);
  requireString(value.taskType, `${location}.taskType`);
  requireObject(value.risk, `${location}.risk`);
  if (!["low", "medium", "high"].includes(value.risk.level)) throw new Error(`${location}.risk.level 必须是 low、medium 或 high`);
  if (!Array.isArray(value.requiredCapabilities)) throw new Error(`${location}.requiredCapabilities 必须是数组`);
  if (typeof value.requiresFreshData !== "boolean") throw new Error(`${location}.requiresFreshData 必须是布尔值`);
}

export function validateRoutingConfiguration(configuration) {
  requireObject(configuration, "routing configuration");
  if (configuration.schemaVersion !== "copilot-routing-config.v3") {
    throw new Error("路由配置 schemaVersion 必须是 copilot-routing-config.v3");
  }
  requireRules(configuration.intentRouting, "intentRouting");
  requireRules(configuration.agentRouting, "agentRouting");
  requireRules(configuration.modelRouting, "modelRouting");
  requireRules(configuration.deploymentRouting, "deploymentRouting");
  requireObject(configuration.intentRouting.defaultOutput, "intentRouting.defaultOutput");
  requireObject(configuration.modelRouting.policies, "modelRouting.policies");
  requireObject(configuration.deploymentRouting.profiles, "deploymentRouting.profiles");
  requireIntentOutput(configuration.intentRouting.defaultOutput, "intentRouting.defaultOutput");
  if (!Array.isArray(configuration.intentRouting.formatPatterns)) throw new Error("intentRouting.formatPatterns 必须是数组");
  for (const [index, format] of configuration.intentRouting.formatPatterns.entries()) {
    requireString(format?.format, `intentRouting.formatPatterns[${index}].format`);
    try { new RegExp(format?.pattern || "", "iu"); }
    catch (error) { throw new Error(`格式规则 ${format?.format || index} 的 pattern 无效：${error.message}`); }
  }
  for (const rule of configuration.intentRouting.rules) {
    requireIntentOutput(rule.output, `意图规则 ${rule.id}.output`);
    try { new RegExp(rule.match?.pattern || "", "iu"); }
    catch (error) { throw new Error(`意图规则 ${rule.id} 的 pattern 无效：${error.message}`); }
  }
  if (!["direct", "continue"].includes(configuration.agentRouting.invalidProposalFallback)) {
    throw new Error("agentRouting.invalidProposalFallback 必须是 direct 或 continue");
  }
  for (const rule of configuration.agentRouting.rules) {
    requireString(rule.targetAgentId, `Agent 规则 ${rule.id}.targetAgentId`);
    if (!["required", "preferred"].includes(rule.enforcement)) throw new Error(`Agent 规则 ${rule.id}.enforcement 无效`);
  }
  requireString(configuration.modelRouting.defaultPolicyId, "modelRouting.defaultPolicyId");
  if (configuration.modelRouting.selectionStrategy !== "hybrid-score") {
    throw new Error("modelRouting.selectionStrategy 必须是 hybrid-score");
  }
  const scoring = configuration.modelRouting.scoring;
  requireObject(scoring, "modelRouting.scoring");
  requireObject(scoring.weights, "modelRouting.scoring.weights");
  const weightNames = ["policyPriority", "reliability", "latency"];
  let weightTotal = 0;
  for (const name of weightNames) {
    const weight = scoring.weights[name];
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error(`modelRouting.scoring.weights.${name} 必须在 0 到 1 之间`);
    weightTotal += weight;
  }
  if (Math.abs(weightTotal - 1) > 0.000001) throw new Error("modelRouting.scoring.weights 总和必须为 1");
  if (!Number.isFinite(scoring.neutralEvidenceScore) || scoring.neutralEvidenceScore < 0 || scoring.neutralEvidenceScore > 1) {
    throw new Error("modelRouting.scoring.neutralEvidenceScore 必须在 0 到 1 之间");
  }
  if (!Number.isInteger(scoring.minimumObservations) || scoring.minimumObservations < 1) throw new Error("modelRouting.scoring.minimumObservations 必须是正整数");
  if (!Number.isFinite(scoring.ewmaAlpha) || scoring.ewmaAlpha <= 0 || scoring.ewmaAlpha > 1) throw new Error("modelRouting.scoring.ewmaAlpha 必须在 0 到 1 之间");
  if (!Number.isInteger(scoring.latencyTargetMs) || scoring.latencyTargetMs < 1) throw new Error("modelRouting.scoring.latencyTargetMs 必须是正整数");
  if (!Number.isInteger(scoring.latencyCeilingMs) || scoring.latencyCeilingMs <= scoring.latencyTargetMs) {
    throw new Error("modelRouting.scoring.latencyCeilingMs 必须大于 latencyTargetMs");
  }
  requireObject(scoring.circuitBreaker, "modelRouting.scoring.circuitBreaker");
  if (!Number.isInteger(scoring.circuitBreaker.failureThreshold) || scoring.circuitBreaker.failureThreshold < 1) {
    throw new Error("modelRouting.scoring.circuitBreaker.failureThreshold 必须是正整数");
  }
  if (!Number.isInteger(scoring.circuitBreaker.cooldownMs) || scoring.circuitBreaker.cooldownMs < 1000) {
    throw new Error("modelRouting.scoring.circuitBreaker.cooldownMs 必须至少为 1000");
  }
  requireObject(scoring.exploration, "modelRouting.scoring.exploration");
  if (typeof scoring.exploration.enabled !== "boolean") throw new Error("modelRouting.scoring.exploration.enabled 必须是布尔值");
  if (!Number.isFinite(scoring.exploration.rate) || scoring.exploration.rate < 0 || scoring.exploration.rate > 0.2) {
    throw new Error("modelRouting.scoring.exploration.rate 必须在 0 到 0.2 之间");
  }
  if (!scoring.exploration.enabled && scoring.exploration.rate !== 0) throw new Error("关闭 exploration 时 rate 必须为 0");
  if (!configuration.modelRouting.policies[configuration.modelRouting.defaultPolicyId]) {
    throw new Error(`默认模型 Policy ${configuration.modelRouting.defaultPolicyId} 不存在`);
  }
  for (const [policyId, policy] of Object.entries(configuration.modelRouting.policies)) {
    if (!Array.isArray(policy.candidateModelAliases) || !policy.candidateModelAliases.length) {
      throw new Error(`模型 Policy ${policyId}.candidateModelAliases 必须是非空数组`);
    }
    const uniqueAliases = new Set();
    for (const [index, alias] of policy.candidateModelAliases.entries()) {
      requireString(alias, `模型 Policy ${policyId}.candidateModelAliases[${index}]`);
      if (uniqueAliases.has(alias)) throw new Error(`模型 Policy ${policyId} 包含重复候选 ${alias}`);
      uniqueAliases.add(alias);
    }
    if (!Number.isFinite(policy.temperature) || policy.temperature < 0 || policy.temperature > 2) throw new Error(`模型 Policy ${policyId}.temperature 必须在 0 到 2 之间`);
    if (!Number.isInteger(policy.maxTokens) || policy.maxTokens < 1) throw new Error(`模型 Policy ${policyId}.maxTokens 必须是正整数`);
  }
  for (const rule of configuration.modelRouting.rules) {
    if (!configuration.modelRouting.policies[rule.policyId]) throw new Error(`模型规则 ${rule.id} 引用了未知 Policy ${rule.policyId}`);
  }
  for (const [profileId, profile] of Object.entries(configuration.deploymentRouting.profiles)) {
    requireString(profile.kind, `Deployment Profile ${profileId}.kind`);
    requireString(profile.baseUrlEnv, `Deployment Profile ${profileId}.baseUrlEnv`);
    requireString(profile.apiKeyEnv, `Deployment Profile ${profileId}.apiKeyEnv`);
    if (!/^[A-Z][A-Z0-9_]+$/u.test(profile.baseUrlEnv) || !/^[A-Z][A-Z0-9_]+$/u.test(profile.apiKeyEnv)) {
      throw new Error(`Deployment Profile ${profileId} 的环境变量引用无效`);
    }
    try { new URL(profile.defaultBaseUrl); }
    catch { throw new Error(`Deployment Profile ${profileId}.defaultBaseUrl 必须是绝对 URL`); }
  }
  const llmAliases = new Set(configuration.deploymentRouting.rules
    .filter(rule => rule.enabled !== false && rule.when?.workloads?.includes("llm"))
    .flatMap(rule => Object.keys(configuration.deploymentRouting.profiles[rule.profileId]?.modelAliases || {})));
  for (const [policyId, policy] of Object.entries(configuration.modelRouting.policies)) {
    const missing = policy.candidateModelAliases.filter(alias => !llmAliases.has(alias));
    if (missing.length) throw new Error(`模型 Policy ${policyId} 的候选缺少 Deployment 映射：${missing.join(", ")}`);
  }
  for (const rule of configuration.deploymentRouting.rules) {
    if (!configuration.deploymentRouting.profiles[rule.profileId]) throw new Error(`部署规则 ${rule.id} 引用了未知 Profile ${rule.profileId}`);
  }
  for (const workload of ["llm", "search"]) {
    if (!configuration.deploymentRouting.rules.some(rule => rule.enabled !== false && rule.when?.workloads?.includes(workload))) {
      throw new Error(`Deployment routing 缺少 ${workload} 工作负载规则`);
    }
  }
  return configuration;
}

export function loadRoutingConfiguration(path = process.env.COPILOT_ROUTING_CONFIG || defaultPath) {
  const resolvedPath = isAbsolute(path) ? path : resolve(projectRoot, path);
  return structuredClone(validateRoutingConfiguration(JSON.parse(readFileSync(resolvedPath, "utf8"))));
}
