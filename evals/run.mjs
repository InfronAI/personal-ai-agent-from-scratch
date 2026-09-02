import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRunOverrides,
  configuredDatasets,
  effectiveConfigurationFingerprint,
  loadEvalConfiguration,
  printableEvalConfiguration,
  resolveEvalPath
} from "./lib/eval-config.mjs";
import { installCliErrorHandler, parseCliOptions } from "./lib/cli.mjs";

installCliErrorHandler("copilot Eval CLI 错误");

const evalRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(evalRoot, "..");

function parseArgs(argv) {
  return parseCliOptions(argv, {
    "--config": { key: "config", type: "string" },
    "--profile": { key: "profile", type: "string" },
    "--dataset": { key: "datasets", type: "string", append: true },
    "--dataset-id": { key: "datasetIds", type: "string", append: true },
    "--case": { key: "cases", type: "string", append: true },
    "--suite": { key: "suites", type: "string", append: true },
    "--tag": { key: "tags", type: "string", append: true },
    "--risk": { key: "risks", type: "string", append: true },
    "--task-type": { key: "taskTypes", type: "string", append: true },
    "--label-status": { key: "labelStatuses", type: "string", append: true },
    "--output": { key: "output", type: "string" },
    "--label": { key: "label", type: "string" },
    "--live": { key: "live", type: "flag", value: true },
    "--offline": { key: "live", type: "flag", value: false },
    "--confirm-live": { key: "confirmLive", type: "flag" },
    "--trace-live": { key: "traceLive", type: "flag", value: true },
    "--no-trace-live": { key: "traceLive", type: "flag", value: false },
    "--judge": { key: "judge", type: "flag", value: true },
    "--no-judge": { key: "judge", type: "flag", value: false },
    "--judge-model": { key: "judgeModel", type: "string" },
    "--ci": { key: "ci", type: "flag" },
    "--print-config": { key: "printConfig", type: "flag" },
    "--list-profiles": { key: "listProfiles", type: "flag" },
    "--help": { key: "help", type: "flag" },
    "-h": { key: "help", type: "flag" }
  }, {
    config: null,
    profile: null,
    datasets: [],
    datasetIds: [],
    cases: [],
    suites: [],
    tags: [],
    risks: [],
    taskTypes: [],
    labelStatuses: [],
    live: undefined,
    confirmLive: false,
    traceLive: undefined,
    judge: undefined,
    judgeModel: null,
    ci: false,
    output: null,
    label: null,
    printConfig: false,
    listProfiles: false
  });
}

function help() {
  return `copilot Eval 运行器

用法：
  node evals/run.mjs [--profile local] [--dataset-id ID] [--dataset FILE] [--case ID]
  node evals/run.mjs --profile live --confirm-live [--trace-live] [--judge]

默认模式使用确定性离线执行，不调用外部 API。
真实模式会调用已配置的 LLM Gateway 或搜索服务，必须使用 --confirm-live。
--judge 会增加尚未校准的 Strict JSON 语义 Judge 和额外模型调用。
--trace-live 会同时把应用运行发送到已配置的 Langfuse 接收端。
--suite、--tag、--risk、--task-type 与 --label-status 可组合筛选样本。
--dataset-id 选择配置内 Dataset；--dataset 追加外部 JSONL 快照。
--print-config 输出合并 Profile、环境变量和命令行后的无密钥配置。`;
}

function runId(mode, label) {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const suffix = crypto.randomBytes(3).toString("hex");
  const cleanLabel = String(label || mode).replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 48);
  return `${cleanLabel}-${timestamp}-${suffix}`;
}

function groupSummary(items, checks) {
  const bySuite = {};
  for (const item of items) {
    const itemChecks = checks.filter(check => check.scopeId === item.id);
    const bucket = bySuite[item.suite] ||= { cases: 0, blockingFailures: 0, diagnosticFailures: 0 };
    bucket.cases += 1;
    bucket.blockingFailures += itemChecks.filter(check => check.severity === "blocking" && check.status !== "pass").length;
    bucket.diagnosticFailures += itemChecks.filter(check => check.severity === "diagnostic" && check.status !== "pass").length;
  }
  const workflowChecks = checks.filter(check => check.scopeId === "workflow");
  bySuite["workflow-contract"] = {
    cases: 0,
    blockingFailures: workflowChecks.filter(check => check.severity === "blocking" && check.status !== "pass").length,
    diagnosticFailures: workflowChecks.filter(check => check.severity === "diagnostic" && check.status !== "pass").length
  };
  const ciChecks = checks.filter(check => check.scopeId === "ci-baseline");
  if (ciChecks.length) bySuite["ci-gate"] = {
    cases: 0,
    blockingFailures: ciChecks.filter(check => check.severity === "blocking" && check.status !== "pass").length,
    diagnosticFailures: ciChecks.filter(check => check.severity === "diagnostic" && check.status !== "pass").length
  };
  return bySuite;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${help()}\n`);
  process.exit(0);
}
const profileName = options.profile || (options.ci ? "ci" : undefined);
const evaluationConfiguration = loadEvalConfiguration({ configPath: options.config, profileName });
if (options.listProfiles) {
  process.stdout.write(`${JSON.stringify({ profiles: evaluationConfiguration.availableProfiles }, null, 2)}\n`);
  process.exit(0);
}
const runSettings = applyRunOverrides(evaluationConfiguration, {
  cases: options.cases,
  suites: options.suites,
  tags: options.tags,
  risks: options.risks,
  taskTypes: options.taskTypes,
  labelStatuses: options.labelStatuses,
  live: options.live,
  traceLive: options.traceLive,
  judge: options.judge,
  judgeModel: options.judgeModel,
  output: options.output,
  datasetIds: options.datasetIds,
  diagnosticDebtRatchet: options.ci ? true : undefined
});
if (options.printConfig) {
  process.stdout.write(`${JSON.stringify(printableEvalConfiguration(evaluationConfiguration, runSettings), null, 2)}\n`);
  process.exit(0);
}
const live = runSettings.execution.mode === "live";
if (live && !options.confirmLive) {
  process.stderr.write("真实 Eval 会消耗模型或搜索额度，请使用 --live --confirm-live 重新执行。\n");
  process.exit(2);
}
if (runSettings.judge.enabled && !live) {
  process.stderr.write("语义 Judge 只能评估真实模型输出，请使用 --live --confirm-live --judge。\n");
  process.exit(2);
}

const tempRoot = mkdtempSync(join(tmpdir(), "copilot-eval-"));
process.env.COPILOT_EVAL_ISOLATED = "true";
process.env.COPILOT_DATABASE_PATH = join(tempRoot, "copilot-eval.sqlite");
process.env.COPILOT_ARTIFACT_DIRECTORY = join(tempRoot, "artifacts");
process.env.COPILOT_RUNTIME_CONFIG_PATH = join(tempRoot, "runtime-settings.json");
process.env.COPILOT_SESSION_SECRET ||= "copilot-eval-isolated-session-secret-0000000000000000";
if (!runSettings.execution.traceLive) {
  process.env.LANGFUSE_PUBLIC_KEY = "";
  process.env.LANGFUSE_SECRET_KEY = "";
  process.env.LANGFUSE_BASE_URL = "";
}

let tracingModule = null;
let exitCode = 0;
try {
  const [datasetModule, { runScriptedScenario, runLiveScenario }, { evaluateScenario }, { auditWorkflow }, { summarizeChecks, writeRunReport }, agentModule, workflowModule, databaseModule, goldenSetModule] = await Promise.all([
    import("./lib/dataset.mjs"),
    import("./lib/scripted-runtime.mjs"),
    import("./lib/evaluators.mjs"),
    import("./lib/workflow-audit.mjs"),
    import("./lib/report.mjs"),
    import("../agent-runtime.mjs"),
    import("../workflow.mjs"),
    import("../database.mjs"),
    import("../golden-set-store.mjs")
  ]);
  if (runSettings.execution.traceLive) tracingModule = await import("../observability.mjs");
  const judgeModule = runSettings.judge.enabled ? await import("./lib/judges.mjs") : null;
  const judgeLlm = runSettings.judge.enabled ? await import("../llm-gateway.mjs") : null;
  const judgeModel = runSettings.judge.model;
  const judgeDefinitions = judgeModule
    ? judgeModule.loadJudgeDefinitions(resolveEvalPath(evaluationConfiguration, runSettings.judge.catalog))
    : null;

  const configuredItems = options.datasetIds.length || !options.datasets.length
    ? datasetModule.loadConfiguredDatasets(configuredDatasets(evaluationConfiguration, runSettings.datasetIds))
    : [];
  const snapshotItems = options.datasets.length
    ? datasetModule.loadDatasets(options.datasets.map(file => resolve(appRoot, file)))
    : [];
  let items = [...configuredItems, ...snapshotItems];
  const duplicateItemIds = items.map(item => item.id).filter((id, index, values) => values.indexOf(id) !== index);
  if (duplicateItemIds.length) throw new Error(`Eval Dataset 快照存在重复 Case ID：${[...new Set(duplicateItemIds)].join(", ")}。`);
  items = datasetModule.selectDatasetItems(items, runSettings.selectors);
  if (!items.length) throw new Error("没有 Eval 数据项符合当前 Dataset、Case 和模式筛选。");
  if (items.length < runSettings.gate.minimumCases) throw new Error(`当前 Profile 至少需要 ${runSettings.gate.minimumCases} 个 Case，筛选后只有 ${items.length} 个。`);

  const id = runId(live ? "live" : "offline", options.label);
  const startedAt = new Date();
  const checks = auditWorkflow({
    agentWorkflow: workflowModule.agentWorkflow,
    workflowAgent: workflowModule.workflowAgent,
    workflowStatus: workflowModule.workflowStatus,
    executableToolNames: agentModule.EXECUTABLE_TOOL_NAMES,
    goldenSetStatus: goldenSetModule.goldenSetStatus
  });
  const cases = [];
  const workflowAgents = [...workflowModule.agentWorkflow.agents.values()];
  for (const item of items) {
    const execution = live
      ? await runLiveScenario(item, { runAgentTurn: agentModule.runAgentTurn })
      : await runScriptedScenario(item, { runAgentTurn: agentModule.runAgentTurn, workflowAgents });
    const itemChecks = evaluateScenario(execution);
    if (judgeModule) itemChecks.push(...await judgeModule.runScenarioJudges(execution, {
      requestCompletion: judgeLlm.requestCompletion,
      model: judgeModel,
      requestIdPrefix: `eval-judge-${id}-${item.id}`,
      definitionIds: runSettings.judge.definitionIds,
      definitions: judgeDefinitions,
      temperature: runSettings.judge.temperature,
      maxTokens: runSettings.judge.maxTokens
    }));
    checks.push(...itemChecks);
    cases.push({
      id: item.id,
      suite: item.suite,
      datasetVersion: item.metadata.dataset_version,
      taskType: item.metadata.task_type,
      risk: item.metadata.risk,
      labelStatus: item.metadata.label_status,
      status: itemChecks.some(check => check.severity === "blocking" && check.status !== "pass") ? "fail" : "pass",
      specialist: execution.result?.specialist || null,
      configuredModel: execution.result?.model || null,
      resolvedModel: execution.result?.resolvedModel || null,
      traceId: execution.result?.traceId || null,
      wallTimeMs: execution.wallTimeMs ? Math.round(execution.wallTimeMs) : null,
      error: execution.error ? { name: execution.error.name, code: execution.error.code || null, message: execution.error.message } : null
    });
  }
  if (runSettings.gate.diagnosticDebtRatchet) {
    const baselinePath = resolveEvalPath(evaluationConfiguration, runSettings.gate.baseline);
    if (!existsSync(baselinePath)) throw new Error(`CI 诊断债务 Ratchet 需要 ${baselinePath}`);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const key = check => `${check.scopeId}::${check.evaluator}`;
    const knownDebt = new Set(baseline.checks
      .filter(check => check.severity === "diagnostic" && check.status !== "pass")
      .map(key));
    const newDebt = checks
      .filter(check => check.severity === "diagnostic" && check.status !== "pass" && !knownDebt.has(key(check)))
      .map(check => ({ scopeId: check.scopeId, evaluator: check.evaluator, status: check.status }));
    checks.push({
      scopeId: "ci-baseline",
      evaluator: "diagnostic_debt_ratchet",
      evaluatorVersion: "1.0.0",
      severity: "blocking",
      status: newDebt.length ? "fail" : "pass",
      score: newDebt.length ? 0 : 1,
      reason: newDebt.length ? `${newDebt.length} 个新增诊断失败不在已评审 Baseline 中。` : "没有引入新的诊断债务。",
      evidence: newDebt
    });
  }
  await tracingModule?.flushTracing();
  const endedAt = new Date();
  const checkSummary = summarizeChecks(checks);
  const report = {
    schemaVersion: "copilot-eval-result.v1",
    runId: id,
    mode: live ? "live" : "offline-scripted",
    label: options.label,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    project: evaluationConfiguration.project,
    release: process.env.COPILOT_RELEASE || "3.0.0",
    modelPolicy: workflowModule.workflowStatus().models,
    judgePolicy: runSettings.judge.enabled ? {
      enabled: true,
      model: judgeModel,
      definitionIds: runSettings.judge.definitionIds,
      temperature: runSettings.judge.temperature,
      maxTokens: runSettings.judge.maxTokens,
      calibrationStatus: "uncalibrated",
      severity: "diagnostic"
    } : { enabled: false },
    configuration: {
      schemaVersion: evaluationConfiguration.schemaVersion,
      profile: evaluationConfiguration.profileName,
      fingerprint: evaluationConfiguration.fingerprint,
      effectiveFingerprint: effectiveConfigurationFingerprint(evaluationConfiguration, runSettings),
      datasetIds: [
        ...(options.datasetIds.length || !options.datasets.length ? runSettings.datasetIds : []),
        ...options.datasets.map(() => "命令行自定义文件")
      ],
      selectors: runSettings.selectors,
      failSeverities: runSettings.gate.failSeverities,
      diagnosticDebtRatchet: runSettings.gate.diagnosticDebtRatchet
    },
    gateProfile: evaluationConfiguration.profileName,
    dataset: datasetModule.datasetSummary(items),
    summary: { cases: cases.length, checks: checkSummary, bySuite: groupSummary(items, checks) },
    cases,
    checks
  };
  const defaultOutput = join(resolveEvalPath(evaluationConfiguration, runSettings.report.directory), `${id}.json`);
  const configuredOutput = runSettings.report.output ? resolveEvalPath(evaluationConfiguration, runSettings.report.output) : null;
  const paths = writeRunReport(report, options.output ? resolve(appRoot, options.output) : configuredOutput || defaultOutput);
  process.stdout.write(`${JSON.stringify({ runId: id, mode: report.mode, summary: report.summary, reports: paths }, null, 2)}\n`);
  exitCode = checks.some(check => runSettings.gate.failSeverities.includes(check.severity) && check.status !== "pass") ? 1 : 0;
  databaseModule.closeDatabase();
} catch (error) {
  process.stderr.write(`copilot Eval 基础设施错误：${error.stack || error.message}\n`);
  exitCode = 2;
} finally {
  await tracingModule?.shutdownTracing();
  rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(exitCode);
