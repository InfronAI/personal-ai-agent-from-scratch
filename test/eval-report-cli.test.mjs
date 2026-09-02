import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = fileURLToPath(new URL("../evals/eval.config.json", import.meta.url));

function command(script, argumentsList) {
  return spawnSync(process.execPath, [script, ...argumentsList], {
    cwd: appRoot,
    encoding: "utf8",
    env: { ...process.env, COPILOT_EVAL_CONFIG: configPath, COPILOT_EVAL_PROFILE: "" }
  });
}

function evalResult(runId, checks, effectiveFingerprint = "a".repeat(64)) {
  return {
    schemaVersion: "copilot-eval-result.v1",
    runId,
    mode: "offline-scripted",
    configuration: { effectiveFingerprint },
    checks
  };
}

test("Eval 对比默认读取配置门禁并生成中英文可读结构报告", () => {
  const directory = mkdtempSync(join(tmpdir(), "copilot-eval-compare-test-"));
  try {
    const baselinePath = join(directory, "baseline.json");
    const candidatePath = join(directory, "candidate.json");
    const outputPath = join(directory, "comparison.json");
    const check = { scopeId: "case-1", evaluator: "answer_nonempty", severity: "blocking", status: "pass", reason: "通过" };
    writeFileSync(baselinePath, JSON.stringify(evalResult("baseline", [check])), "utf8");
    writeFileSync(candidatePath, JSON.stringify(evalResult("candidate", [check])), "utf8");
    const result = command("evals/compare.mjs", [
      "--baseline", baselinePath,
      "--candidate", candidatePath,
      "--output", outputPath
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(report.summary.gateFailed, false);
    assert.equal(report.summary.coverageChanged, 0);
    assert.equal(existsSync(outputPath.replace(/\.json$/u, ".md")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Eval 对比在配置要求下阻断覆盖变化", () => {
  const directory = mkdtempSync(join(tmpdir(), "copilot-eval-coverage-test-"));
  try {
    const baselinePath = join(directory, "baseline.json");
    const candidatePath = join(directory, "candidate.json");
    const outputPath = join(directory, "comparison.json");
    const check = { scopeId: "case-1", evaluator: "answer_nonempty", severity: "blocking", status: "pass", reason: "通过" };
    writeFileSync(baselinePath, JSON.stringify(evalResult("baseline", [check])), "utf8");
    writeFileSync(candidatePath, JSON.stringify(evalResult("candidate", [])), "utf8");
    const result = command("evals/compare.mjs", [
      "--baseline", baselinePath,
      "--candidate", candidatePath,
      "--output", outputPath
    ]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).summary.coverageChanged, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Judge 校准强制人工标签完整匹配并生成混淆矩阵", () => {
  const directory = mkdtempSync(join(tmpdir(), "copilot-eval-calibration-test-"));
  try {
    const resultPath = join(directory, "judge-run.json");
    const annotationsPath = join(directory, "annotations.jsonl");
    const outputPath = join(directory, "calibration.json");
    const checks = [
      { scopeId: "case-1", evaluator: "intent_semantic_fit", severity: "diagnostic", status: "fail", reason: "失败" },
      { scopeId: "case-2", evaluator: "intent_semantic_fit", severity: "diagnostic", status: "pass", reason: "通过" }
    ];
    writeFileSync(resultPath, JSON.stringify(evalResult("judge-run", checks)), "utf8");
    writeFileSync(annotationsPath, [
      JSON.stringify({ id: "case-1", evaluator: "intent_semantic_fit", human_label: "fail", label_status: "human-reviewed", reviewer: "reviewer-a", reviewed_at: "2026-08-31T00:00:00.000Z" }),
      JSON.stringify({ id: "case-2", evaluator: "intent_semantic_fit", human_label: "pass", label_status: "human-reviewed", reviewer: "reviewer-b", reviewed_at: "2026-08-31T00:00:00.000Z" })
    ].join("\n"), "utf8");
    const result = command("evals/calibrate.mjs", [
      "--annotations", annotationsPath,
      "--results", resultPath,
      "--output", outputPath
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(report.matchedCount, 2);
    assert.equal(report.evaluators.intent_semantic_fit.accuracy, 1);
    assert.deepEqual(report.unmatched, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
