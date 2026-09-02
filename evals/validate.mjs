import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { datasetFingerprint, loadConfiguredDatasets, selectDatasetItems } from "./lib/dataset.mjs";
import { configuredDatasets, effectiveConfigurationFingerprint, loadEvalConfiguration, resolveEvalPath } from "./lib/eval-config.mjs";
import { loadJudgeDefinitions, selectJudgeDefinitions } from "./lib/judges.mjs";
import { loadBenchmarkCatalog, validateBenchmarkMetadata } from "./lib/benchmark-catalog.mjs";
import { installCliErrorHandler, parseCliOptions } from "./lib/cli.mjs";

installCliErrorHandler("copilot Eval 配置验证错误");

function parseArguments(argv) {
  return parseCliOptions(argv, {
    "--config": { key: "config", type: "string" },
    "--help": { key: "help", type: "flag" },
    "-h": { key: "help", type: "flag" }
  }, { config: null, help: false });
}

function usage() {
  return `copilot Eval 配置验证器

用法：
  node evals/validate.mjs [--config FILE]

验证配置协议、Profile 继承、Dataset 声明版本、样本 ID、选择器、Judge 定义和 Langfuse 同步范围。`;
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

try {
  const base = loadEvalConfiguration({ configPath: options.config });
  const schemaPath = resolveEvalPath(base, "schemas/eval-config.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  if (schema.$id !== "https://personal-copilot.local/schemas/copilot-eval-config.v1.json") throw new Error("Eval 配置 Schema ID 不正确。");

  const allDescriptors = configuredDatasets(base, Object.keys(base.datasets));
  const allItems = loadConfiguredDatasets(allDescriptors);
  const benchmarkCatalog = loadBenchmarkCatalog(base.benchmarkCatalog.path);
  if (benchmarkCatalog.catalogVersion !== base.benchmarkCatalog.version) throw new Error("Benchmark Catalog 版本与 Eval 配置不一致。");
  const benchmarkCoverage = validateBenchmarkMetadata(allItems, benchmarkCatalog);
  if (!benchmarkCoverage.valid) throw new Error(`Benchmark 元数据无效：${benchmarkCoverage.failures.join("；")}`);
  const liveItemsWithInjectedSearchEvidence = allItems
    .filter(item => item.metadata.live_eligible === true && Array.isArray(item.input?.search_results));
  if (liveItemsWithInjectedSearchEvidence.length) {
    throw new Error(`真实 Eval 样本不能依赖离线 search_results fixture：${liveItemsWithInjectedSearchEvidence.map(item => item.id).join("、")}`);
  }
  const baselinePath = resolveEvalPath(base, base.run.gate.baseline);
  if (!existsSync(baselinePath)) throw new Error(`Baseline 不存在：${baselinePath}。`);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (baseline.schemaVersion !== "copilot-eval-result.v1") throw new Error("Baseline 不是 copilot-eval-result.v1。 ");
  const localConfiguration = loadEvalConfiguration({ configPath: base.configPath, profileName: "local", env: process.env });
  const expectedBaselineFingerprint = effectiveConfigurationFingerprint(localConfiguration);
  if (baseline.configuration?.effectiveFingerprint !== expectedBaselineFingerprint) {
    throw new Error("Baseline 的有效配置指纹已过期；请在完整离线回归通过后重建 Baseline。 ");
  }
  const localIds = new Set(localConfiguration.run.datasetIds);
  const localItems = selectDatasetItems(allItems.filter(item => localIds.has(item.datasetId)), localConfiguration.run.selectors);
  if (baseline.summary?.cases !== localItems.length) throw new Error(`Baseline 包含 ${baseline.summary?.cases ?? 0} 个 Case，当前 local Profile 包含 ${localItems.length} 个。`);
  if (baseline.dataset?.fingerprint !== datasetFingerprint(localItems)) throw new Error("Baseline 的 Dataset 内容指纹已过期；请审核数据变更并重建 Baseline。 ");
  const byDataset = Object.fromEntries(allDescriptors.map(descriptor => [
    descriptor.id,
    allItems.filter(item => item.datasetId === descriptor.id).length
  ]));
  const profiles = {};
  for (const profileName of base.availableProfiles) {
    const configuration = loadEvalConfiguration({ configPath: base.configPath, profileName, env: process.env });
    const ids = new Set(configuration.run.datasetIds);
    const selected = selectDatasetItems(allItems.filter(item => ids.has(item.datasetId)), configuration.run.selectors);
    if (selected.length < configuration.run.gate.minimumCases) {
      throw new Error(`Profile ${profileName} 只选中 ${selected.length} 个 Case，低于 minimumCases=${configuration.run.gate.minimumCases}。`);
    }
    const judgeDefinitions = loadJudgeDefinitions(resolveEvalPath(configuration, configuration.run.judge.catalog));
    selectJudgeDefinitions(configuration.run.judge.definitionIds, judgeDefinitions);
    profiles[profileName] = {
      mode: configuration.run.execution.mode,
      cases: selected.length,
      judge: configuration.run.judge.enabled,
      traceLive: configuration.run.execution.traceLive,
      diagnosticDebtRatchet: configuration.run.gate.diagnosticDebtRatchet
    };
  }

  const syncIds = new Set(base.langfuse.sync.datasetIds);
  const syncItems = allItems.filter(item => syncIds.has(item.datasetId))
    .filter(item => !base.langfuse.sync.liveEligibleOnly || item.metadata.live_eligible === true);
  if (!syncItems.length) throw new Error("Langfuse 同步配置没有选中任何 Case。");

  process.stdout.write(`${JSON.stringify({
    status: "通过",
    schemaVersion: base.schemaVersion,
    configPath: resolve(base.configPath),
    fingerprint: base.fingerprint,
    effectiveFingerprint: effectiveConfigurationFingerprint(base),
    datasets: byDataset,
    datasetFingerprint: datasetFingerprint(allItems),
    totalCases: allItems.length,
    benchmarkCatalog: {
      version: benchmarkCatalog.catalogVersion,
      references: benchmarkCatalog.benchmarks.length,
      adaptedCases: benchmarkCoverage.benchmarkItems,
      families: benchmarkCoverage.families
    },
    baseline: {
      path: baselinePath,
      runId: baseline.runId,
      cases: baseline.summary?.cases || null
    },
    profiles,
    langfuseSyncCases: syncItems.length
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`copilot Eval 配置验证失败：${error.stack || error.message}\n`);
  process.exit(2);
}
