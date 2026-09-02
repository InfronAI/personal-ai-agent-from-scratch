import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  configuredDatasets,
  effectiveConfigurationFingerprint,
  loadEvalConfiguration,
  printableEvalConfiguration,
  resolveEvalPath
} from "./lib/eval-config.mjs";
import { installCliErrorHandler, parseCliOptions } from "./lib/cli.mjs";

installCliErrorHandler("copilot Langfuse CLI 错误");

const evalRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(evalRoot, "..");

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const initial = {
    command,
    config: null,
    datasets: [],
    datasetName: null,
    includeNonLive: false,
    concurrency: null,
    maxConcurrency: null,
    confirmLive: false,
    runName: null,
    experimentName: null,
    output: null,
    printConfig: false
  };
  if (command === "--help" || command === "-h") return { ...initial, help: true };
  return parseCliOptions(rest, {
    "--config": { key: "config", type: "string" },
    "--dataset": { key: "datasets", type: "string", append: true },
    "--dataset-name": { key: "datasetName", type: "string" },
    "--include-non-live": { key: "includeNonLive", type: "flag" },
    "--concurrency": { key: "concurrency", type: "integer" },
    "--max-concurrency": { key: "maxConcurrency", type: "integer" },
    "--run-name": { key: "runName", type: "string" },
    "--experiment-name": { key: "experimentName", type: "string" },
    "--output": { key: "output", type: "string" },
    "--confirm-live": { key: "confirmLive", type: "flag" },
    "--print-config": { key: "printConfig", type: "flag" },
    "--help": { key: "help", type: "flag" },
    "-h": { key: "help", type: "flag" }
  }, initial);
}

function usage() {
  return `copilot Langfuse 数据集与实验工具

用法：
  node evals/langfuse.mjs sync [--config FILE] [--dataset FILE] [--dataset-name NAME]
  node evals/langfuse.mjs run --confirm-live [--config FILE] [--dataset-name NAME] [--run-name NAME]

命令：
  sync  将仓库内的版本化 JSONL 样本幂等同步到 Langfuse Dataset。
  run   对已同步的数据集执行真实 copilot 工作流，并写入 Trace、逐项 Score 与聚合 Score。

安全约束：
  run 会消耗真实模型及搜索额度，必须显式提供 --confirm-live。
  sync 默认只同步 metadata.live_eligible=true 的样本；--include-non-live 会包含全部样本。`;
}

function positiveInteger(value, name, fallback, maximum = 10) {
  if (value === undefined || value === null || Number.isNaN(value)) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} 必须是 1 到 ${maximum} 之间的整数。`);
  return value;
}

function defaultRunName() {
  return `copilot-${new Date().toISOString().replace(/[:.]/gu, "-")}-${crypto.randomBytes(3).toString("hex")}`;
}

const options = parseArguments(process.argv.slice(2));
if (options.help || !options.command) {
  process.stdout.write(`${usage()}\n`);
  process.exit(options.command ? 0 : 2);
}
if (!["sync", "run"].includes(options.command)) {
  process.stderr.write(`不支持的命令：${options.command}\n\n${usage()}\n`);
  process.exit(2);
}
const evaluationConfiguration = loadEvalConfiguration({ configPath: options.config });
if (options.printConfig) {
  process.stdout.write(`${JSON.stringify(printableEvalConfiguration(evaluationConfiguration), null, 2)}\n`);
  process.exit(0);
}
if (options.command === "run" && !options.confirmLive) {
  process.stderr.write("真实实验会消耗模型或搜索额度，请增加 --confirm-live 后重新执行。\n");
  process.exit(2);
}

let temporaryRoot = null;
let tracingModule = null;
let databaseModule = null;
let langfuseModule = null;
let exitCode = 0;
try {
  if (options.command === "run") {
    temporaryRoot = mkdtempSync(join(tmpdir(), "copilot-langfuse-eval-"));
    process.env.COPILOT_EVAL_ISOLATED = "true";
    process.env.COPILOT_DATABASE_PATH = join(temporaryRoot, "copilot-eval.sqlite");
    process.env.COPILOT_ARTIFACT_DIRECTORY = join(temporaryRoot, "artifacts");
    process.env.COPILOT_RUNTIME_CONFIG_PATH = join(temporaryRoot, "runtime-settings.json");
    process.env.COPILOT_SESSION_SECRET ||= "copilot-langfuse-eval-session-secret-000000000000";
  }

  const adapter = await import("./lib/langfuse-adapter.mjs");
  const datasetModule = await import("./lib/dataset.mjs");
  langfuseModule = await import("../langfuse-client.mjs");
  const { config } = await import("../config.mjs");
  options.datasetName ||= evaluationConfiguration.langfuse.datasetName;
  if (!langfuseModule.langfuseClient) {
    throw new Error("未配置 Langfuse。请设置 LANGFUSE_PUBLIC_KEY、LANGFUSE_SECRET_KEY 和 LANGFUSE_BASE_URL。");
  }

  if (options.command === "sync") {
    const items = options.datasets.length
      ? datasetModule.loadDatasets(options.datasets.map(file => resolve(appRoot, file)))
      : datasetModule.loadConfiguredDatasets(configuredDatasets(evaluationConfiguration, evaluationConfiguration.langfuse.sync.datasetIds));
    const liveEligibleOnly = options.includeNonLive ? false : evaluationConfiguration.langfuse.sync.liveEligibleOnly;
    const result = await adapter.syncLangfuseDataset({
      client: langfuseModule.langfuseClient,
      items,
      datasetName: options.datasetName,
      datasetDescription: evaluationConfiguration.langfuse.datasetDescription,
      includeNonLive: !liveEligibleOnly,
      concurrency: positiveInteger(options.concurrency, "--concurrency", evaluationConfiguration.langfuse.sync.concurrency),
      configurationFingerprint: evaluationConfiguration.fingerprint
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    tracingModule = await import("../observability.mjs");
    const agentModule = await import("../agent-runtime.mjs");
    const workflowModule = await import("../workflow.mjs");
    databaseModule = await import("../database.mjs");
    const runName = options.runName || defaultRunName();
    const result = await adapter.runLangfuseExperiment({
      client: langfuseModule.langfuseClient,
      runAgentTurn: agentModule.runAgentTurn,
      datasetName: options.datasetName,
      experimentName: options.experimentName || evaluationConfiguration.langfuse.experiment.name,
      runName,
      description: evaluationConfiguration.langfuse.experiment.description,
      maxConcurrency: positiveInteger(options.maxConcurrency, "--max-concurrency", evaluationConfiguration.langfuse.experiment.maxConcurrency),
      metadata: {
        eval_config_profile: evaluationConfiguration.profileName,
        eval_config_fingerprint: evaluationConfiguration.fingerprint,
        eval_effective_config_fingerprint: effectiveConfigurationFingerprint(evaluationConfiguration),
        service_version: config.service.version,
        model_policy: workflowModule.workflowStatus().models,
        deployment_profile: workflowModule.workflowStatus().deployment.profileId
      }
    });
    await tracingModule.flushTracing();
    await langfuseModule.langfuseClient.flush();
    const summary = adapter.summarizeLangfuseExperiment(result);
    const outputPath = options.output
      ? resolve(appRoot, options.output)
      : join(resolveEvalPath(evaluationConfiguration, evaluationConfiguration.langfuse.experiment.outputDirectory), `langfuse-${runName.replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 96)}.json`);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...summary, outputPath }, null, 2)}\n`);
    const casePass = summary.runScores.find(score => score.name === "copilot.case_pass_rate");
    if (casePass && Number(casePass.value) < 1) exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`copilot Langfuse 评测失败：${error.stack || error.message}\n`);
  exitCode = 2;
} finally {
  await tracingModule?.shutdownTracing();
  await langfuseModule?.shutdownLangfuseClient();
  databaseModule?.closeDatabase();
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}
process.exit(exitCode);
