import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { loadEvalConfiguration, resolveEvalPath } from "./lib/eval-config.mjs";
import { installCliErrorHandler, parseCliOptions } from "./lib/cli.mjs";

installCliErrorHandler("copilot Eval 对比错误");

function args(argv) {
  return parseCliOptions(argv, {
    "--config": { key: "config", type: "string" },
    "--profile": { key: "profile", type: "string" },
    "--baseline": { key: "baseline", type: "string" },
    "--candidate": { key: "candidate", type: "string" },
    "--output": { key: "output", type: "string" },
    "--help": { key: "help", type: "flag" },
    "-h": { key: "help", type: "flag" }
  }, { config: null, profile: null, baseline: null, candidate: null, output: null, help: false });
}

function load(path) {
  const value = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (value.schemaVersion !== "copilot-eval-result.v1") throw new Error(`${path} 不是 copilot Eval Result v1 文件`);
  return value;
}

function key(check) {
  return `${check.scopeId}::${check.evaluator}`;
}

function state(check) {
  return check?.status === "pass" ? "pass" : check ? "fail" : "missing";
}

const options = args(process.argv.slice(2));
if (options.help) {
  process.stdout.write("用法：node evals/compare.mjs --candidate CANDIDATE.json [--baseline BASELINE.json] [--config FILE] [--output REPORT.json]\n");
  process.exit(0);
}
if (!options.candidate) throw new Error("缺少 --candidate。用法：node evals/compare.mjs --candidate CANDIDATE.json [--baseline BASELINE.json]");
const configuration = loadEvalConfiguration({ configPath: options.config, profileName: options.profile });
const baselinePath = options.baseline || resolveEvalPath(configuration, configuration.run.gate.baseline);
const baseline = load(baselinePath);
const candidate = load(options.candidate);
const baselineByKey = new Map(baseline.checks.map(check => [key(check), check]));
const candidateByKey = new Map(candidate.checks.map(check => [key(check), check]));
const keys = [...new Set([...baselineByKey.keys(), ...candidateByKey.keys()])].sort();
const transitions = keys.map(id => {
  const before = baselineByKey.get(id);
  const after = candidateByKey.get(id);
  const beforeState = state(before);
  const afterState = state(after);
  let transition = "unchanged";
  if (beforeState === "missing" || afterState === "missing") transition = "coverage_changed";
  else if (beforeState !== "pass" && afterState === "pass") transition = "fixed";
  else if (beforeState === "pass" && afterState !== "pass") transition = "regressed";
  return {
    key: id,
    scopeId: after?.scopeId || before?.scopeId,
    evaluator: after?.evaluator || before?.evaluator,
    severity: after?.severity || before?.severity,
    before: beforeState,
    after: afterState,
    transition,
    candidateReason: after?.reason || null
  };
});
const blockingRegressions = transitions.filter(item => item.severity === "blocking" && item.transition === "regressed");
const candidateBlockingFailures = candidate.checks.filter(check => check.severity === "blocking" && check.status !== "pass");
const report = {
  schemaVersion: "copilot-eval-comparison.v1",
  configuration: {
    schemaVersion: configuration.schemaVersion,
    fingerprint: configuration.fingerprint,
    failOnCoverageChange: configuration.comparison.failOnCoverageChange,
    failOnCandidateBlockingFailure: configuration.comparison.failOnCandidateBlockingFailure
  },
  baseline: baseline.runId,
  candidate: candidate.runId,
  baselineMode: baseline.mode,
  candidateMode: candidate.mode,
  summary: {
    checksCompared: transitions.length,
    fixed: transitions.filter(item => item.transition === "fixed").length,
    regressed: transitions.filter(item => item.transition === "regressed").length,
    coverageChanged: transitions.filter(item => item.transition === "coverage_changed").length,
    blockingRegressions: blockingRegressions.length,
    candidateBlockingFailures: candidateBlockingFailures.length,
    configurationChanged: baseline.configuration?.effectiveFingerprint !== candidate.configuration?.effectiveFingerprint,
    gateFailed: false
  },
  transitions
};
report.summary.gateFailed = Boolean(
  blockingRegressions.length
  || (configuration.comparison.failOnCandidateBlockingFailure && candidateBlockingFailures.length)
  || (configuration.comparison.failOnCoverageChange && report.summary.coverageChanged)
);
const json = `${JSON.stringify(report, null, 2)}\n`;
const comparisonName = `${String(baseline.runId).replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 48)}--${String(candidate.runId).replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 48)}.json`;
const outputPath = options.output
  ? resolve(options.output)
  : join(resolveEvalPath(configuration, configuration.comparison.outputDirectory), comparisonName);
const markdownPath = extname(outputPath) === ".json" ? outputPath.slice(0, -5) + ".md" : `${outputPath}.md`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, json, "utf8");
const changed = transitions.filter(item => item.transition !== "unchanged");
const markdown = [
  `# copilot Eval 对比：${baseline.runId} → ${candidate.runId}`,
  "",
  `- 已修复：${report.summary.fixed}`,
  `- 已回退：${report.summary.regressed}`,
  `- 覆盖变化：${report.summary.coverageChanged}`,
  `- 阻断回退：${report.summary.blockingRegressions}`,
  `- 候选阻断失败：${report.summary.candidateBlockingFailures}`,
  `- 有效配置变化：${report.summary.configurationChanged ? "是" : "否"}`,
  `- 覆盖变化是否阻断：${configuration.comparison.failOnCoverageChange ? "是" : "否"}`,
  `- 对比门禁：${report.summary.gateFailed ? "未通过" : "通过"}`,
  "",
  "## 变化项",
  "",
  ...(changed.length ? [
    "| 状态变化 | 级别 | 范围 | Evaluator | 候选原因 |",
    "|---|---|---|---|---|",
    ...changed.map(item => `| ${item.transition} | ${item.severity} | ${item.scopeId} | ${item.evaluator} | ${String(item.candidateReason || "").replaceAll("|", "\\|")} |`)
  ] : ["无；所有检查状态一致。"]),
  ""
].join("\n");
writeFileSync(markdownPath, markdown, "utf8");
process.stdout.write(`${JSON.stringify({
  baseline: report.baseline,
  candidate: report.candidate,
  summary: report.summary,
  changes: transitions.filter(item => item.transition !== "unchanged"),
  reports: { jsonPath: outputPath, markdownPath }
}, null, 2)}\n`);
process.exit(report.summary.gateFailed ? 1 : 0);
