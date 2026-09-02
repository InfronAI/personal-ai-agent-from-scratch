import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

function count(results, predicate) {
  return results.filter(predicate).length;
}

export function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: count(checks, item => item.status === "pass"),
    failed: count(checks, item => item.status === "fail"),
    errors: count(checks, item => item.status === "error"),
    blockingFailures: count(checks, item => item.severity === "blocking" && (item.status === "fail" || item.status === "error")),
    diagnosticFailures: count(checks, item => item.severity === "diagnostic" && (item.status === "fail" || item.status === "error"))
  };
}

function tableEscape(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function markdownReport(run) {
  const failed = run.checks.filter(check => check.status !== "pass");
  const bySuite = Object.entries(run.summary.bySuite || {});
  const lines = [
    `# copilot Eval 报告：${run.runId}`,
    "",
    `- 模式：${run.mode}`,
    `- Eval Profile：${run.configuration?.profile || run.gateProfile || "未知"}`,
    `- 有效配置指纹：${run.configuration?.effectiveFingerprint || "未记录"}`,
    `- Dataset 内容指纹：${run.dataset?.fingerprint || "未记录"}`,
    `- 数据项：${run.summary.cases}`,
    `- Evaluator 检查：${run.summary.checks.total}`,
    `- 阻断失败：${run.summary.checks.blockingFailures}`,
    `- 诊断失败：${run.summary.checks.diagnosticFailures}`,
    `- 执行时长：${run.durationMs} ms`,
    "",
    "## 测试套件结果",
    "",
    "| 测试套件 | Case 数 | 阻断失败 | 诊断失败 |",
    "|---|---:|---:|---:|",
    ...bySuite.map(([suite, value]) => `| ${tableEscape(suite)} | ${value.cases} | ${value.blockingFailures} | ${value.diagnosticFailures} |`),
    "",
    "## 未通过项",
    ""
  ];
  if (!failed.length) lines.push("无。所有检查均通过。");
  else {
    lines.push("| 级别 | 范围 | Evaluator | 结果 | 原因 |", "|---|---|---|---|---|");
    for (const item of failed) lines.push(`| ${item.severity} | ${tableEscape(item.scopeId)} | ${tableEscape(item.evaluator)} | ${item.status} | ${tableEscape(item.reason)} |`);
  }
  lines.push(
    "",
    "## 解释",
    "",
    "阻断失败表示已批准的工程契约被破坏；诊断失败表示已知架构债务或尚未升级为发布门禁的信号。规约推导样本验证的是产品契约，不代表真实用户分布或人工标注的回答质量。",
    ""
  );
  return lines.join("\n");
}

export function writeRunReport(run, outputPath) {
  const jsonPath = resolve(outputPath);
  const markdownPath = extname(jsonPath) === ".json" ? jsonPath.slice(0, -5) + ".md" : `${jsonPath}.md`;
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, markdownReport(run), "utf8");
  return { jsonPath, markdownPath };
}
