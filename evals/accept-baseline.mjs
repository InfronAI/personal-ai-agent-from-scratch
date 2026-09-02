import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { datasetFingerprint, loadConfiguredDatasets, selectDatasetItems } from "./lib/dataset.mjs";
import { configuredDatasets, effectiveConfigurationFingerprint, loadEvalConfiguration, resolveEvalPath } from "./lib/eval-config.mjs";
import { markdownReport } from "./lib/report.mjs";
import { installCliErrorHandler, parseCliOptions } from "./lib/cli.mjs";

installCliErrorHandler("copilot Eval 基线更新错误");

const options = parseCliOptions(process.argv.slice(2), {
  "--run": { key: "run", type: "string" },
  "--help": { key: "help", type: "flag" },
  "-h": { key: "help", type: "flag" }
}, { run: null, help: false });

if (options.help || !options.run) {
  process.stdout.write("用法：node evals/accept-baseline.mjs --run evals/results/<完整离线结果>.json\n");
  process.exit(options.help ? 0 : 2);
}

const configuration = loadEvalConfiguration({ profileName: "local" });
const reportPath = resolve(options.run);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const items = selectDatasetItems(
  loadConfiguredDatasets(configuredDatasets(configuration)),
  configuration.run.selectors
);

if (report.schemaVersion !== "copilot-eval-result.v1") throw new Error("候选结果协议不正确。");
if (report.mode !== "offline-scripted" || report.configuration?.profile !== "local") {
  throw new Error("只能接受完整 local 离线运行作为发布基线。");
}
if (report.configuration?.effectiveFingerprint !== effectiveConfigurationFingerprint(configuration)) {
  throw new Error("候选结果的有效配置指纹与当前 local 配置不一致。");
}
if (report.dataset?.fingerprint !== datasetFingerprint(items) || report.summary?.cases !== items.length) {
  throw new Error("候选结果没有覆盖当前 local Profile 的完整 Dataset。");
}
if (report.summary?.checks?.blockingFailures || report.summary?.checks?.diagnosticFailures || report.summary?.checks?.errors) {
  throw new Error("候选结果仍有失败、错误或未评审诊断债务，不能成为发布基线。");
}

const baselinePath = resolveEvalPath(configuration, configuration.run.gate.baseline);
const markdownPath = baselinePath.replace(/\.json$/u, ".md");
writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(markdownPath, markdownReport(report), "utf8");
process.stdout.write(`${JSON.stringify({
  status: "已接受",
  source: reportPath,
  baseline: baselinePath,
  markdown: markdownPath,
  cases: report.summary.cases,
  checks: report.summary.checks.total,
  runId: report.runId
}, null, 2)}\n`);
