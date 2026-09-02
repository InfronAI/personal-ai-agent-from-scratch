import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sha256Value } from "./fingerprint.mjs";

const ROLES = new Set(["system", "user", "assistant", "tool"]);
const LABEL_STATUSES = new Set(["specification-derived", "code-derived", "draft", "human-reviewed"]);
const EVALUATION_DIMENSIONS = new Set(["product_contract", "general_knowledge", "vertical_capability", "performance_resilience", "safety_compliance", "agent_capability"]);
const DIFFICULTIES = new Set(["foundational", "intermediate", "advanced", "adversarial"]);
const INTERACTION_PATTERNS = new Set(["single_turn", "multi_turn", "tool_augmented", "multimodal"]);
const DECISION_USES = new Set(["release_gate", "regression", "diagnostic", "model_selection"]);

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function validateMessage(message, location) {
  assertion(message && typeof message === "object" && !Array.isArray(message), `${location} 必须是对象`);
  assertion(ROLES.has(message.role), `${location}.role 必须是以下值之一：${[...ROLES].join(", ")}`);
  assertion(typeof message.content === "string" && message.content.trim(), `${location}.content 必须是非空字符串`);
}

export function validateDatasetItem(item, location = "dataset item") {
  assertion(item && typeof item === "object" && !Array.isArray(item), `${location} 必须是对象`);
  assertion(/^[a-z0-9][a-z0-9._-]{7,159}$/.test(String(item.id || "")), `${location}.id 无效`);
  assertion(typeof item.suite === "string" && item.suite.trim(), `${location}.suite 为必填项`);
  assertion(item.input && typeof item.input === "object", `${location}.input 为必填项`);
  assertion(Array.isArray(item.input.messages) && item.input.messages.length > 0, `${location}.input.messages 不能为空`);
  item.input.messages.forEach((message, index) => validateMessage(message, `${location}.input.messages[${index}]`));
  assertion(item.input.messages.at(-1).role === "user", `${location} 必须以 User 消息结束`);
  assertion(item.expected && typeof item.expected === "object", `${location}.expected 为必填项`);
  assertion(item.metadata && typeof item.metadata === "object", `${location}.metadata 为必填项`);
  assertion(LABEL_STATUSES.has(item.metadata.label_status), `${location}.metadata.label_status 无效`);
  assertion(typeof item.metadata.dataset_version === "string" && item.metadata.dataset_version, `${location}.metadata.dataset_version 为必填项`);
  if (item.metadata.evaluation_dimension !== undefined) assertion(EVALUATION_DIMENSIONS.has(item.metadata.evaluation_dimension), `${location}.metadata.evaluation_dimension 无效`);
  if (item.metadata.difficulty !== undefined) assertion(DIFFICULTIES.has(item.metadata.difficulty), `${location}.metadata.difficulty 无效`);
  if (item.metadata.interaction_pattern !== undefined) assertion(INTERACTION_PATTERNS.has(item.metadata.interaction_pattern), `${location}.metadata.interaction_pattern 无效`);
  if (item.metadata.decision_use !== undefined) assertion(DECISION_USES.has(item.metadata.decision_use), `${location}.metadata.decision_use 无效`);
  for (const key of ["capability", "domain"]) {
    if (item.metadata[key] !== undefined) assertion(typeof item.metadata[key] === "string" && item.metadata[key].trim(), `${location}.metadata.${key} 必须是非空字符串`);
  }
  const benchmarkFields = ["benchmark_family", "benchmark_task", "benchmark_reference_id", "benchmark_adaptation"];
  const benchmarkFieldCount = benchmarkFields.filter(key => item.metadata[key] !== undefined).length;
  assertion(benchmarkFieldCount === 0 || benchmarkFieldCount === benchmarkFields.length, `${location}.metadata 的 Benchmark 字段必须同时存在。`);
  if (benchmarkFieldCount) {
    assertion(item.metadata.benchmark_family === item.metadata.benchmark_reference_id, `${location}.metadata 的 Benchmark family 与 reference_id 必须一致。`);
    assertion(item.metadata.benchmark_adaptation === "methodology-inspired-original", `${location}.metadata.benchmark_adaptation 无效。`);
  }
  if (item.evidence !== undefined) {
    assertion(item.evidence && typeof item.evidence === "object" && !Array.isArray(item.evidence), `${location}.evidence 必须是对象`);
    assertion(item.evidence.schemaVersion === "copilot-eval-evidence.v1", `${location}.evidence.schemaVersion 无效`);
    assertion(item.evidence.scope === "target-trace+session-prefix", `${location}.evidence.scope 无效`);
    assertion(item.evidence.subject?.type === "turn", `${location}.evidence.subject.type 必须是 turn`);
    assertion(item.evidence.subject?.requestId && item.evidence.subject.requestId === item.evidence.trace?.requestId, `${location}.evidence 的 Trace 与反馈 Turn 不一致`);
    assertion(item.evidence.session?.boundary?.requestId === item.evidence.subject.requestId, `${location}.evidence 的 Session 边界与反馈 Turn 不一致`);
    assertion(item.evidence.session?.boundary?.excludesFutureTurns === true, `${location}.evidence 必须排除被评价 Turn 之后的消息`);
    assertion(Array.isArray(item.evidence.session?.turns) && item.evidence.session.turns.length > 0, `${location}.evidence.session.turns 不能为空`);
    assertion(item.evidence.coverage?.targetTraceCaptured === true, `${location}.evidence 必须包含目标 Trace`);
    assertion(/^[a-f0-9]{64}$/u.test(String(item.evidence.contentHash || "")), `${location}.evidence.contentHash 无效`);
  }
  if (item.input.script !== undefined) {
    assertion(Array.isArray(item.input.script) && item.input.script.length > 0, `${location}.input.script 不能为空`);
    for (const [index, step] of item.input.script.entries()) {
      assertion(typeof step.agent === "string" && step.agent, `${location}.input.script[${index}].agent 为必填项`);
      assertion(["answer", "tool", "tools"].includes(step.action), `${location}.input.script[${index}].action 无效`);
      if (step.action === "answer") assertion(typeof step.content === "string" && step.content.trim(), `${location}.input.script[${index}].content 为必填项`);
      if (step.action === "tool") assertion(typeof step.tool === "string" && step.tool, `${location}.input.script[${index}].tool 为必填项`);
      if (step.action === "tools") assertion(Array.isArray(step.calls) && step.calls.length > 0, `${location}.input.script[${index}].calls 为必填项`);
    }
  }
  if (item.input.artifact_names !== undefined) {
    assertion(Array.isArray(item.input.artifact_names) && item.input.artifact_names.length <= 10, `${location}.input.artifact_names 必须是长度不超过 10 的数组`);
    item.input.artifact_names.forEach((name, index) => assertion(typeof name === "string" && name.trim(), `${location}.input.artifact_names[${index}] 必须是非空字符串`));
  }
  if (item.input.artifact_seed !== undefined) {
    assertion(Array.isArray(item.input.artifact_seed), `${location}.input.artifact_seed 必须是数组`);
    item.input.artifact_seed.forEach((artifact, index) => {
      assertion(artifact && typeof artifact === "object" && !Array.isArray(artifact), `${location}.input.artifact_seed[${index}] 必须是对象`);
      assertion(typeof artifact.content === "string", `${location}.input.artifact_seed[${index}].content 必须是字符串`);
    });
  }
  if (item.input.search_error !== undefined) {
    assertion(item.input.search_error && typeof item.input.search_error === "object" && !Array.isArray(item.input.search_error), `${location}.input.search_error 必须是对象`);
  }
  if (item.input.search_results !== undefined) {
    assertion(Array.isArray(item.input.search_results) && item.input.search_results.length > 0, `${location}.input.search_results 必须是非空数组`);
    assertion(item.metadata.live_eligible !== true, `${location} 使用离线 search_results fixture，不能标记为 live_eligible=true`);
  }
  const response = item.expected.response;
  if (response !== undefined) {
    assertion(response && typeof response === "object" && !Array.isArray(response), `${location}.expected.response 必须是对象`);
    if (response.answer_pattern !== undefined) {
      assertion(typeof response.answer_pattern === "string" && response.answer_pattern, `${location}.expected.response.answer_pattern 必须是非空字符串`);
      try { new RegExp(response.answer_pattern, "u"); } catch (error) { throw new Error(`${location}.expected.response.answer_pattern 不是有效正则：${error.message}`); }
    }
    for (const key of ["exact_line_count", "exact_bullet_count"]) {
      if (response[key] !== undefined) assertion(Number.isInteger(response[key]) && response[key] >= 0, `${location}.expected.response.${key} 必须是非负整数`);
    }
    if (response.required_json_keys !== undefined) {
      assertion(Array.isArray(response.required_json_keys) && response.required_json_keys.length > 0, `${location}.expected.response.required_json_keys 必须是非空数组`);
      assertion(response.required_json_keys.every(key => typeof key === "string" && key), `${location}.expected.response.required_json_keys 只能包含字符串`);
      assertion(new Set(response.required_json_keys).size === response.required_json_keys.length, `${location}.expected.response.required_json_keys 不能重复`);
    }
  }
  return item;
}

export function loadDataset(file) {
  const absolutePath = resolve(file);
  const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/u);
  const items = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch (error) {
      throw new Error(`${absolutePath}:${index + 1} 不是有效 JSON：${error.message}`);
    }
    validateDatasetItem(item, `${absolutePath}:${index + 1}`);
    items.push({ ...item, datasetFile: absolutePath });
  }
  assertion(items.length > 0, `${absolutePath} 不包含 Eval 数据项`);
  return items;
}

export function loadDatasets(files) {
  const items = files.flatMap(loadDataset);
  const seen = new Set();
  for (const item of items) {
    assertion(!seen.has(item.id), `Eval 数据项 ID 重复：${item.id}`);
    seen.add(item.id);
  }
  return items;
}

export function loadConfiguredDatasets(descriptors) {
  const items = [];
  const seen = new Set();
  for (const descriptor of descriptors) {
    const loaded = loadDataset(descriptor.path);
    for (const item of loaded) {
      assertion(item.metadata.dataset_version === descriptor.version, `${descriptor.id} 中的 ${item.id} 声明版本 ${item.metadata.dataset_version}，与配置版本 ${descriptor.version} 不一致`);
      assertion(!seen.has(item.id), `Eval 数据项 ID 重复：${item.id}`);
      seen.add(item.id);
      items.push({ ...item, datasetId: descriptor.id, datasetDimension: descriptor.dimension });
    }
  }
  return items;
}

function matchesOne(value, selected) {
  return !selected.length || selected.includes(value);
}

export function selectDatasetItems(items, selectors = {}) {
  const normalized = {
    cases: selectors.cases || [],
    suites: selectors.suites || [],
    tags: selectors.tags || [],
    risks: selectors.risks || [],
    taskTypes: selectors.taskTypes || [],
    labelStatuses: selectors.labelStatuses || [],
    liveEligibleOnly: selectors.liveEligibleOnly === true
  };
  return items.filter(item => {
    if (!matchesOne(item.id, normalized.cases)) return false;
    if (!matchesOne(item.suite, normalized.suites)) return false;
    if (!matchesOne(item.metadata.risk, normalized.risks)) return false;
    if (!matchesOne(item.metadata.task_type, normalized.taskTypes)) return false;
    if (!matchesOne(item.metadata.label_status, normalized.labelStatuses)) return false;
    if (normalized.tags.length && !normalized.tags.some(tag => (item.metadata.tags || []).includes(tag))) return false;
    if (normalized.liveEligibleOnly && item.metadata.live_eligible !== true) return false;
    return true;
  });
}

export function datasetSummary(items) {
  const countValues = values => Object.fromEntries([...new Set(values.map(value => value || "unknown"))]
    .sort()
    .map(value => [value, values.filter(candidate => (candidate || "unknown") === value).length]));
  const countBy = key => countValues(items.map(item => item.metadata[key]));
  return {
    items: items.length,
    fingerprint: datasetFingerprint(items),
    configuredDatasets: countValues(items.map(item => item.datasetId)),
    datasets: countBy("dataset_version"),
    evaluationDimensions: countValues(items.map(item => item.metadata.evaluation_dimension || item.datasetDimension || "product_contract")),
    domains: countValues(items.map(item => item.metadata.domain || "unspecified")),
    difficulties: countValues(items.map(item => item.metadata.difficulty || "unspecified")),
    benchmarkFamilies: countValues(items.filter(item => item.metadata.benchmark_family).map(item => item.metadata.benchmark_family)),
    taskTypes: countBy("task_type"),
    risks: countBy("risk"),
    sources: countBy("source"),
    labelStatuses: countBy("label_status")
  };
}

export function datasetFingerprint(items) {
  const normalized = items
    .map(item => {
      const value = structuredClone(item);
      delete value.datasetFile;
      return value;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256Value(normalized);
}
