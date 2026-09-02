import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = fileURLToPath(new URL("../evals/eval.config.json", import.meta.url));

function run(argumentsList) {
  return spawnSync(process.execPath, argumentsList, {
    cwd: appRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      COPILOT_EVAL_CONFIG: configPath,
      COPILOT_EVAL_PROFILE: ""
    }
  });
}

test("Eval CLI 把 Profile、选择器和有效配置指纹写入报告", () => {
  const directory = mkdtempSync(join(tmpdir(), "copilot-eval-cli-test-"));
  try {
    const output = join(directory, "single-case.json");
    const result = run([
      "evals/run.mjs",
      "--profile", "local",
      "--case", "core-direct-stable-qa-001",
      "--output", output
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.summary.cases, 1);
    assert.equal(report.configuration.profile, "local");
    assert.deepEqual(report.configuration.selectors.cases, ["core-direct-stable-qa-001"]);
    assert.match(report.configuration.effectiveFingerprint, /^[a-f0-9]{64}$/u);
    assert.match(report.dataset.fingerprint, /^[a-f0-9]{64}$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CI Profile 拒绝因筛选导致的覆盖静默缩水", () => {
  const result = run([
    "evals/run.mjs",
    "--profile", "ci",
    "--case", "core-direct-stable-qa-001"
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /至少需要 140 个 Case/u);
});

test("Eval CLI 可按配置 ID 冻结 Dataset 范围", () => {
  const directory = mkdtempSync(join(tmpdir(), "copilot-eval-dataset-id-test-"));
  try {
    const output = join(directory, "core-only.json");
    const result = run([
      "evals/run.mjs",
      "--profile", "local",
      "--dataset-id", "core",
      "--output", output
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(report.configuration.datasetIds, ["core"]);
    assert.equal(report.summary.cases, 19);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
