import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import {
  applyStoredRuntimeSettings,
  resolveRuntimeSettingsPath,
  webRuntimeConfigurationEnabled
} from "../../runtime-settings.mjs";
import { sha256Text, sha256Value } from "./fingerprint.mjs";

export const DEFAULT_EVAL_CONFIG_PATH = fileURLToPath(new URL("../eval.config.json", import.meta.url));
const appRoot = fileURLToPath(new URL("../../", import.meta.url));

const PROFILE_KEYS = new Set(["extends", "datasetIds", "selectors", "execution", "judge", "gate", "report"]);
const RUN_KEYS = new Set(["datasetIds", "selectors", "execution", "judge", "gate", "report"]);
const SELECTOR_KEYS = new Set(["cases", "suites", "tags", "risks", "taskTypes", "labelStatuses", "liveEligibleOnly"]);
const EXECUTION_KEYS = new Set(["mode", "traceLive"]);
const JUDGE_KEYS = new Set(["enabled", "catalog", "model", "definitionIds", "temperature", "maxTokens"]);
const GATE_KEYS = new Set(["failSeverities", "diagnosticDebtRatchet", "baseline", "minimumCases"]);
const REPORT_KEYS = new Set(["directory", "output"]);
const LABEL_STATUSES = new Set(["specification-derived", "code-derived", "draft", "human-reviewed"]);
const RISKS = new Set(["low", "medium", "high"]);

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value, allowed, location) {
  assertion(isObject(value), `${location} 必须是对象。`);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  assertion(!unknown.length, `${location} 包含未知字段：${unknown.join(", ")}。`);
}

function assertString(value, location) {
  assertion(typeof value === "string" && value.trim(), `${location} 必须是非空字符串。`);
}

function assertStringArray(value, location, { allowed = null, allowEmpty = true } = {}) {
  assertion(Array.isArray(value), `${location} 必须是数组。`);
  assertion(allowEmpty || value.length > 0, `${location} 不能为空。`);
  assertion(value.every(item => typeof item === "string" && item.trim()), `${location} 只能包含非空字符串。`);
  assertion(new Set(value).size === value.length, `${location} 不能包含重复值。`);
  if (allowed) assertion(value.every(item => allowed.has(item)), `${location} 包含不支持的值。`);
}

function assertInteger(value, location, min, max = Number.MAX_SAFE_INTEGER) {
  assertion(Number.isInteger(value) && value >= min && value <= max, `${location} 必须是 ${min} 到 ${max} 之间的整数。`);
}

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return structuredClone(override);
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (key === "extends") continue;
    merged[key] = isObject(value) && isObject(merged[key]) ? deepMerge(merged[key], value) : structuredClone(value);
  }
  return merged;
}

function validateSelectors(value, location) {
  assertKeys(value, SELECTOR_KEYS, location);
  for (const key of ["cases", "suites", "tags", "taskTypes"]) assertStringArray(value[key], `${location}.${key}`);
  assertStringArray(value.risks, `${location}.risks`, { allowed: RISKS });
  assertStringArray(value.labelStatuses, `${location}.labelStatuses`, { allowed: LABEL_STATUSES });
  assertion(typeof value.liveEligibleOnly === "boolean", `${location}.liveEligibleOnly 必须是布尔值。`);
}

function validateRunSettings(value, location, datasetIds) {
  assertKeys(value, RUN_KEYS, location);
  assertStringArray(value.datasetIds, `${location}.datasetIds`, { allowEmpty: false });
  const unknownDatasets = value.datasetIds.filter(id => !datasetIds.has(id));
  assertion(!unknownDatasets.length, `${location}.datasetIds 引用了未知数据集：${unknownDatasets.join(", ")}。`);

  validateSelectors(value.selectors, `${location}.selectors`);
  assertKeys(value.execution, EXECUTION_KEYS, `${location}.execution`);
  assertion(["offline-scripted", "live"].includes(value.execution.mode), `${location}.execution.mode 不受支持。`);
  assertion(typeof value.execution.traceLive === "boolean", `${location}.execution.traceLive 必须是布尔值。`);

  assertKeys(value.judge, JUDGE_KEYS, `${location}.judge`);
  assertion(typeof value.judge.enabled === "boolean", `${location}.judge.enabled 必须是布尔值。`);
  assertString(value.judge.catalog, `${location}.judge.catalog`);
  assertString(value.judge.model, `${location}.judge.model`);
  assertStringArray(value.judge.definitionIds, `${location}.judge.definitionIds`, { allowEmpty: false });
  assertion(Number.isFinite(value.judge.temperature) && value.judge.temperature >= 0 && value.judge.temperature <= 2, `${location}.judge.temperature 必须在 0 到 2 之间。`);
  assertInteger(value.judge.maxTokens, `${location}.judge.maxTokens`, 100, 16_384);

  assertKeys(value.gate, GATE_KEYS, `${location}.gate`);
  assertStringArray(value.gate.failSeverities, `${location}.gate.failSeverities`, { allowed: new Set(["blocking", "diagnostic"]), allowEmpty: false });
  assertion(value.gate.failSeverities.includes("blocking"), `${location}.gate.failSeverities 必须包含 blocking，不能通过配置绕过阻断契约。`);
  assertion(typeof value.gate.diagnosticDebtRatchet === "boolean", `${location}.gate.diagnosticDebtRatchet 必须是布尔值。`);
  assertString(value.gate.baseline, `${location}.gate.baseline`);
  assertInteger(value.gate.minimumCases, `${location}.gate.minimumCases`, 1);

  assertKeys(value.report, REPORT_KEYS, `${location}.report`);
  assertString(value.report.directory, `${location}.report.directory`);
  assertion(value.report.output === null || (typeof value.report.output === "string" && value.report.output.trim()), `${location}.report.output 必须是 null 或非空字符串。`);
  assertion(!value.judge.enabled || value.execution.mode === "live", `${location} 启用 Judge 时 execution.mode 必须是 live。`);
  assertion(!value.execution.traceLive || value.execution.mode === "live", `${location} 启用真实 Trace 时 execution.mode 必须是 live。`);
  assertion(value.execution.mode !== "live" || value.selectors.liveEligibleOnly, `${location} 真实运行必须启用 selectors.liveEligibleOnly，避免执行只适用于离线 Fixture 的样本。`);
}

function validatePartialProfile(value, location) {
  assertKeys(value, PROFILE_KEYS, location);
  if (value.extends !== undefined) assertString(value.extends, `${location}.extends`);
  if (value.datasetIds !== undefined) assertStringArray(value.datasetIds, `${location}.datasetIds`, { allowEmpty: false });
  if (value.selectors !== undefined) assertKeys(value.selectors, SELECTOR_KEYS, `${location}.selectors`);
  if (value.execution !== undefined) assertKeys(value.execution, EXECUTION_KEYS, `${location}.execution`);
  if (value.judge !== undefined) assertKeys(value.judge, JUDGE_KEYS, `${location}.judge`);
  if (value.gate !== undefined) assertKeys(value.gate, GATE_KEYS, `${location}.gate`);
  if (value.report !== undefined) assertKeys(value.report, REPORT_KEYS, `${location}.report`);
}

function resolveProfiles(raw) {
  const resolved = new Map();
  const resolving = new Set();
  const resolveProfile = name => {
    if (resolved.has(name)) return resolved.get(name);
    const profile = raw.profiles[name];
    assertion(profile, `Eval Profile 不存在：${name}。`);
    assertion(!resolving.has(name), `Eval Profile 存在循环继承：${[...resolving, name].join(" → ")}。`);
    resolving.add(name);
    const parent = profile.extends ? resolveProfile(profile.extends) : raw.defaults;
    const value = deepMerge(parent, profile);
    resolving.delete(name);
    resolved.set(name, value);
    return value;
  };
  for (const name of Object.keys(raw.profiles)) resolveProfile(name);
  return resolved;
}

function validateRawConfig(raw) {
  const topKeys = new Set(["$schema", "schemaVersion", "project", "benchmarkCatalog", "datasets", "defaults", "profiles", "comparison", "calibration", "goldenSet", "langfuse"]);
  assertKeys(raw, topKeys, "Eval 配置");
  if (raw.$schema !== undefined) assertString(raw.$schema, "Eval 配置 $schema");
  assertion(raw.schemaVersion === "copilot-eval-config.v1", "Eval 配置 schemaVersion 必须是 copilot-eval-config.v1。");
  assertString(raw.project, "Eval 配置 project");
  assertKeys(raw.benchmarkCatalog, new Set(["file", "version"]), "benchmarkCatalog");
  assertString(raw.benchmarkCatalog.file, "benchmarkCatalog.file");
  assertString(raw.benchmarkCatalog.version, "benchmarkCatalog.version");
  assertion(isObject(raw.datasets) && Object.keys(raw.datasets).length > 0, "Eval 配置 datasets 至少需要一个数据集。 ");
  for (const [id, dataset] of Object.entries(raw.datasets)) {
    assertString(id, "Dataset ID");
    assertKeys(dataset, new Set(["file", "version", "dimension", "purpose"]), `datasets.${id}`);
    assertString(dataset.file, `datasets.${id}.file`);
    assertString(dataset.version, `datasets.${id}.version`);
    assertion(["product_contract", "general_knowledge", "vertical_capability", "performance_resilience", "safety_compliance", "agent_capability"].includes(dataset.dimension), `datasets.${id}.dimension 无效。`);
    assertString(dataset.purpose, `datasets.${id}.purpose`);
  }
  const datasetIds = new Set(Object.keys(raw.datasets));
  assertion(isObject(raw.profiles) && Object.keys(raw.profiles).length > 0, "Eval 配置 profiles 至少需要一个 Profile。 ");
  for (const [name, profile] of Object.entries(raw.profiles)) validatePartialProfile(profile, `profiles.${name}`);
  const profiles = resolveProfiles(raw);
  validateRunSettings(raw.defaults, "defaults", datasetIds);
  for (const [name, profile] of profiles) validateRunSettings(profile, `profiles.${name}（合并后）`, datasetIds);

  assertKeys(raw.comparison, new Set(["failOnCoverageChange", "failOnCandidateBlockingFailure", "outputDirectory"]), "comparison");
  assertion(typeof raw.comparison.failOnCoverageChange === "boolean", "comparison.failOnCoverageChange 必须是布尔值。");
  assertion(typeof raw.comparison.failOnCandidateBlockingFailure === "boolean", "comparison.failOnCandidateBlockingFailure 必须是布尔值。");
  assertion(raw.comparison.failOnCandidateBlockingFailure, "comparison.failOnCandidateBlockingFailure 必须为 true，不能通过配置绕过候选阻断失败。 ");
  assertString(raw.comparison.outputDirectory, "comparison.outputDirectory");

  assertKeys(raw.calibration, new Set(["requiredLabelStatus", "positiveClass", "requireAllAnnotationsMatched", "outputDirectory"]), "calibration");
  assertion(raw.calibration.requiredLabelStatus === "human-reviewed", "calibration.requiredLabelStatus 必须是 human-reviewed。 ");
  assertion(raw.calibration.positiveClass === "fail", "calibration.positiveClass 必须是 fail。 ");
  assertion(typeof raw.calibration.requireAllAnnotationsMatched === "boolean", "calibration.requireAllAnnotationsMatched 必须是布尔值。 ");
  assertString(raw.calibration.outputDirectory, "calibration.outputDirectory");

  assertKeys(raw.goldenSet, new Set(["source", "candidateTable", "evidenceTable", "goldenTable", "evidenceSchemaVersion", "evidenceScope", "sessionBoundary", "requiredReviewStatus", "requiredLabelStatus", "export"]), "goldenSet");
  assertion(raw.goldenSet.source === "user-feedback", "goldenSet.source 必须是 user-feedback。");
  assertString(raw.goldenSet.candidateTable, "goldenSet.candidateTable");
  assertion(raw.goldenSet.evidenceTable === "eval_evidence_snapshots", "goldenSet.evidenceTable 必须是 eval_evidence_snapshots。");
  assertString(raw.goldenSet.goldenTable, "goldenSet.goldenTable");
  assertion(raw.goldenSet.evidenceSchemaVersion === "copilot-eval-evidence.v1", "goldenSet.evidenceSchemaVersion 无效。");
  assertion(raw.goldenSet.evidenceScope === "target-trace+session-prefix", "goldenSet.evidenceScope 无效。");
  assertion(raw.goldenSet.sessionBoundary === "through-evaluated-turn", "goldenSet.sessionBoundary 无效。");
  assertion(raw.goldenSet.requiredReviewStatus === "approved", "goldenSet.requiredReviewStatus 必须是 approved。");
  assertion(raw.goldenSet.requiredLabelStatus === "human-reviewed", "goldenSet.requiredLabelStatus 必须是 human-reviewed。");
  assertKeys(raw.goldenSet.export, new Set(["file", "datasetVersion"]), "goldenSet.export");
  assertString(raw.goldenSet.export.file, "goldenSet.export.file");
  assertString(raw.goldenSet.export.datasetVersion, "goldenSet.export.datasetVersion");

  assertKeys(raw.langfuse, new Set(["datasetName", "datasetDescription", "sync", "experiment"]), "langfuse");
  assertString(raw.langfuse.datasetName, "langfuse.datasetName");
  assertString(raw.langfuse.datasetDescription, "langfuse.datasetDescription");
  assertKeys(raw.langfuse.sync, new Set(["datasetIds", "liveEligibleOnly", "concurrency"]), "langfuse.sync");
  assertStringArray(raw.langfuse.sync.datasetIds, "langfuse.sync.datasetIds", { allowEmpty: false });
  const unknownSyncDatasets = raw.langfuse.sync.datasetIds.filter(id => !datasetIds.has(id));
  assertion(!unknownSyncDatasets.length, `langfuse.sync.datasetIds 引用了未知数据集：${unknownSyncDatasets.join(", ")}。`);
  assertion(typeof raw.langfuse.sync.liveEligibleOnly === "boolean", "langfuse.sync.liveEligibleOnly 必须是布尔值。");
  assertInteger(raw.langfuse.sync.concurrency, "langfuse.sync.concurrency", 1, 10);
  assertKeys(raw.langfuse.experiment, new Set(["name", "description", "maxConcurrency", "outputDirectory"]), "langfuse.experiment");
  assertString(raw.langfuse.experiment.name, "langfuse.experiment.name");
  assertString(raw.langfuse.experiment.description, "langfuse.experiment.description");
  assertInteger(raw.langfuse.experiment.maxConcurrency, "langfuse.experiment.maxConcurrency", 1, 10);
  assertString(raw.langfuse.experiment.outputDirectory, "langfuse.experiment.outputDirectory");
  return profiles;
}

function configurationFingerprint(rawText) {
  return sha256Text(rawText);
}

export function effectiveConfigurationFingerprint(configuration, run = configuration.run) {
  const behavior = structuredClone(run);
  delete behavior.report;
  if (!behavior.judge.enabled) behavior.judge = { enabled: false };
  if (!behavior.gate.diagnosticDebtRatchet) delete behavior.gate.baseline;
  const value = {
    schemaVersion: configuration.schemaVersion,
    project: configuration.project,
    benchmarkCatalog: {
      file: configuration.benchmarkCatalog.file,
      version: configuration.benchmarkCatalog.version
    },
    profile: configuration.profileName,
    datasets: behavior.datasetIds.map(id => ({
      id,
      file: configuration.datasets[id]?.file,
      version: configuration.datasets[id]?.version
    })),
    run: behavior
  };
  return sha256Value(value);
}

export function loadEvalConfiguration(options = {}) {
  if (!Object.hasOwn(options, "env")) {
    dotenv.config({ path: resolve(appRoot, ".env"), quiet: true });
    dotenv.config({ path: resolve(appRoot, "../../.env"), override: false, quiet: true });
    applyStoredRuntimeSettings({
      path: resolveRuntimeSettingsPath({ appRoot }),
      enabled: webRuntimeConfigurationEnabled()
    });
  }
  const { configPath, profileName } = options;
  const env = options.env || process.env;
  const absolutePath = configPath
    ? resolve(configPath)
    : env.COPILOT_EVAL_CONFIG
      ? resolve(appRoot, env.COPILOT_EVAL_CONFIG)
      : DEFAULT_EVAL_CONFIG_PATH;
  let rawText;
  try {
    rawText = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`无法读取 Eval 配置 ${absolutePath}：${error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Eval 配置不是有效 JSON：${error.message}`);
  }
  const profiles = validateRawConfig(raw);
  const selectedProfile = profileName || env.COPILOT_EVAL_PROFILE || "local";
  assertion(profiles.has(selectedProfile), `Eval Profile 不存在：${selectedProfile}。可用值：${[...profiles.keys()].join(", ")}。`);
  const run = structuredClone(profiles.get(selectedProfile));
  const langfuse = structuredClone(raw.langfuse);
  if (env.COPILOT_EVAL_JUDGE_MODEL?.trim()) run.judge.model = env.COPILOT_EVAL_JUDGE_MODEL.trim();
  if (env.COPILOT_EVAL_OUTPUT_DIRECTORY?.trim()) run.report.directory = env.COPILOT_EVAL_OUTPUT_DIRECTORY.trim();
  if (env.COPILOT_LANGFUSE_EVAL_DATASET?.trim()) langfuse.datasetName = env.COPILOT_LANGFUSE_EVAL_DATASET.trim().slice(0, 200);
  const directory = dirname(absolutePath);
  return {
    schemaVersion: raw.schemaVersion,
    project: raw.project,
    benchmarkCatalog: {
      ...structuredClone(raw.benchmarkCatalog),
      path: resolve(directory, raw.benchmarkCatalog.file)
    },
    configPath: absolutePath,
    configDirectory: directory,
    fingerprint: configurationFingerprint(rawText),
    profileName: selectedProfile,
    availableProfiles: [...profiles.keys()],
    datasets: Object.fromEntries(Object.entries(raw.datasets).map(([id, dataset]) => [id, {
      id,
      ...structuredClone(dataset),
      path: resolve(directory, dataset.file)
    }])),
    run,
    comparison: structuredClone(raw.comparison),
    calibration: structuredClone(raw.calibration),
    goldenSet: structuredClone(raw.goldenSet),
    langfuse
  };
}

export function configuredDatasets(configuration, datasetIds = configuration.run.datasetIds) {
  assertStringArray(datasetIds, "datasetIds", { allowEmpty: false });
  return datasetIds.map(id => {
    const dataset = configuration.datasets[id];
    assertion(dataset, `未知 Dataset ID：${id}。`);
    return structuredClone(dataset);
  });
}

export function resolveEvalPath(configuration, path) {
  return resolve(configuration.configDirectory, path);
}

export function applyRunOverrides(configuration, overrides = {}) {
  const run = structuredClone(configuration.run);
  const selectorKeys = ["cases", "suites", "tags", "risks", "taskTypes", "labelStatuses"];
  for (const key of selectorKeys) {
    if (Array.isArray(overrides[key]) && overrides[key].length) run.selectors[key] = [...new Set(overrides[key])];
  }
  if (overrides.live !== undefined) run.execution.mode = overrides.live ? "live" : "offline-scripted";
  if (overrides.live === true) run.selectors.liveEligibleOnly = true;
  if (overrides.traceLive !== undefined) run.execution.traceLive = overrides.traceLive;
  if (overrides.judge !== undefined) run.judge.enabled = overrides.judge;
  if (overrides.judgeModel) run.judge.model = overrides.judgeModel;
  if (overrides.output) run.report.output = overrides.output;
  if (overrides.diagnosticDebtRatchet !== undefined) run.gate.diagnosticDebtRatchet = overrides.diagnosticDebtRatchet;
  if (overrides.datasetIds?.length) run.datasetIds = [...new Set(overrides.datasetIds)];
  validateRunSettings(run, "解析后的运行配置", new Set(Object.keys(configuration.datasets)));
  return run;
}

export function printableEvalConfiguration(configuration, run = configuration.run) {
  return {
    schemaVersion: configuration.schemaVersion,
    project: configuration.project,
    profile: configuration.profileName,
    fingerprint: configuration.fingerprint,
    effectiveFingerprint: effectiveConfigurationFingerprint(configuration, run),
    configPath: configuration.configPath,
    datasets: configuredDatasets(configuration, run.datasetIds).map(({ id, file, version, purpose }) => ({ id, file, version, purpose })),
    run: structuredClone(run),
    comparison: structuredClone(configuration.comparison),
    calibration: structuredClone(configuration.calibration),
    goldenSet: structuredClone(configuration.goldenSet),
    benchmarkCatalog: structuredClone(configuration.benchmarkCatalog),
    langfuse: structuredClone(configuration.langfuse)
  };
}
