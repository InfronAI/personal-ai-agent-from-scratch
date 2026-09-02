import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { effectiveConfigurationFingerprint, loadEvalConfiguration, resolveEvalPath } from "./lib/eval-config.mjs";
import { installCliErrorHandler, parseCliOptions } from "./lib/cli.mjs";

installCliErrorHandler("copilot Judge 校准错误");

function parseArgs(argv) {
  return parseCliOptions(argv, {
    "--config": { key: "config", type: "string" },
    "--annotations": { key: "annotations", type: "string" },
    "--results": { key: "results", type: "string" },
    "--output": { key: "output", type: "string" },
    "--help": { key: "help", type: "flag" },
    "-h": { key: "help", type: "flag" }
  }, { config: null, annotations: null, results: null, output: null, help: false });
}

function readJsonl(path, requiredLabelStatus) {
  return readFileSync(resolve(path), "utf8").split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const value = JSON.parse(line);
    if (!value.id || !value.evaluator || !["pass", "fail"].includes(value.human_label)) throw new Error(`${path}:${index + 1} 必须包含 id、evaluator 和 human_label=pass|fail`);
    if (value.label_status !== requiredLabelStatus) throw new Error(`${path}:${index + 1} 必须设置 label_status=${requiredLabelStatus}`);
    return value;
  });
}

function safeDivide(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write("用法：node evals/calibrate.mjs --annotations human.jsonl --results eval-result.json [--config FILE] [--output calibration.json]\n");
  process.exit(0);
}
if (!options.annotations || !options.results) throw new Error("必须同时提供 --annotations 和 --results。 ");
const configuration = loadEvalConfiguration({ configPath: options.config });
const annotations = readJsonl(options.annotations, configuration.calibration.requiredLabelStatus);
const evalRun = JSON.parse(readFileSync(resolve(options.results), "utf8"));
const checks = new Map(evalRun.checks.map(check => [`${check.scopeId}::${check.evaluator}`, check]));
const grouped = new Map();
const unmatched = [];
for (const annotation of annotations) {
  const judge = checks.get(`${annotation.id}::${annotation.evaluator}`);
  if (!judge || !["pass", "fail"].includes(judge.status)) {
    unmatched.push({ id: annotation.id, evaluator: annotation.evaluator });
    continue;
  }
  const bucket = grouped.get(annotation.evaluator) || { tp: 0, tn: 0, fp: 0, fn: 0, samples: 0 };
  const humanFail = annotation.human_label === "fail";
  const judgeFail = judge.status === "fail";
  if (humanFail && judgeFail) bucket.tp += 1;
  else if (!humanFail && !judgeFail) bucket.tn += 1;
  else if (!humanFail && judgeFail) bucket.fp += 1;
  else bucket.fn += 1;
  bucket.samples += 1;
  grouped.set(annotation.evaluator, bucket);
}
if (configuration.calibration.requireAllAnnotationsMatched && unmatched.length) {
  throw new Error(`${unmatched.length} 条人工标注没有匹配到可校准的 Judge 结果。`);
}
const evaluators = Object.fromEntries([...grouped.entries()].map(([name, matrix]) => {
  const precision = safeDivide(matrix.tp, matrix.tp + matrix.fp);
  const recall = safeDivide(matrix.tp, matrix.tp + matrix.fn);
  return [name, {
    ...matrix,
    positiveClass: "fail",
    precision,
    recall,
    f1: precision === null || recall === null ? null : safeDivide(2 * precision * recall, precision + recall),
    accuracy: safeDivide(matrix.tp + matrix.tn, matrix.samples),
    falsePassRate: safeDivide(matrix.fn, matrix.tp + matrix.fn)
  }];
}));
const report = {
  schemaVersion: "copilot-judge-calibration.v1",
  evalRunId: evalRun.runId,
  configuration: {
    schemaVersion: configuration.schemaVersion,
    fingerprint: configuration.fingerprint,
    effectiveFingerprint: effectiveConfigurationFingerprint(configuration),
    positiveClass: configuration.calibration.positiveClass,
    requiredLabelStatus: configuration.calibration.requiredLabelStatus
  },
  annotationCount: annotations.length,
  matchedCount: Object.values(evaluators).reduce((sum, item) => sum + item.samples, 0),
  unmatched,
  note: "正类是业务失败；falsePassRate 表示被 Judge 错误放行的人工失败样本比例。",
  evaluators
};
const output = `${JSON.stringify(report, null, 2)}\n`;
const defaultName = `calibration-${String(evalRun.runId || "unknown").replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 96)}.json`;
const path = options.output
  ? resolve(options.output)
  : resolve(resolveEvalPath(configuration, configuration.calibration.outputDirectory), defaultName);
const markdownPath = extname(path) === ".json" ? path.slice(0, -5) + ".md" : `${path}.md`;
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, output, "utf8");
{
  const lines = [
    `# copilot Judge 校准：${evalRun.runId}`,
    "",
    `- 人工标注：${report.annotationCount}`,
    `- 成功匹配：${report.matchedCount}`,
    "- 正类：业务失败（fail）",
    "",
    "| Evaluator | 样本数 | Precision | Recall | F1 | Accuracy | False Pass Rate |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(evaluators).map(([name, metric]) => {
      const format = value => value === null ? "N/A" : value.toFixed(4);
      return `| ${name} | ${metric.samples} | ${format(metric.precision)} | ${format(metric.recall)} | ${format(metric.f1)} | ${format(metric.accuracy)} | ${format(metric.falsePassRate)} |`;
    }),
    "",
    "`False Pass` 是人工判定失败、Judge 却放行的样本；在提升为发布门禁前应优先压低该指标。",
    ""
  ];
  writeFileSync(markdownPath, lines.join("\n"), "utf8");
}
process.stdout.write(`${JSON.stringify({ ...report, reports: { jsonPath: path, markdownPath } }, null, 2)}\n`);
