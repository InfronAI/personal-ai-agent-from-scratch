import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { datasetFingerprint, loadConfiguredDatasets, selectDatasetItems, validateDatasetItem } from "../evals/lib/dataset.mjs";
import { parseCliOptions } from "../evals/lib/cli.mjs";
import {
  applyRunOverrides,
  configuredDatasets,
  effectiveConfigurationFingerprint,
  loadEvalConfiguration,
  printableEvalConfiguration
} from "../evals/lib/eval-config.mjs";
import { loadJudgeDefinitions, selectJudgeDefinitions } from "../evals/lib/judges.mjs";
import { persistRuntimeSettings } from "../runtime-settings.mjs";

const configPath = fileURLToPath(new URL("../evals/eval.config.json", import.meta.url));

test("默认 Eval 配置集中解析数据集、门禁和报告策略", () => {
  const configuration = loadEvalConfiguration({ configPath, env: {} });
  assert.equal(configuration.profileName, "local");
  assert.deepEqual(configuration.run.datasetIds, [
    "core",
    "multiturn",
    "adversarial",
    "general-knowledge",
    "vertical-capabilities",
    "performance-resilience",
    "safety-compliance",
    "agent-capabilities",
    "benchmark-knowledge-reasoning",
    "benchmark-professional-domains",
    "benchmark-agentic",
    "benchmark-safety",
    "benchmark-grounded-research",
    "benchmark-memory-personalization",
    "benchmark-multilingual-instruction",
    "benchmark-high-stakes-professional",
    "benchmark-cybersecurity",
    "benchmark-software-data"
  ]);
  assert.equal(configuration.run.execution.mode, "offline-scripted");
  assert.deepEqual(configuration.run.gate.failSeverities, ["blocking"]);
  assert.match(configuration.fingerprint, /^[a-f0-9]{64}$/u);
  const printable = printableEvalConfiguration(configuration);
  assert.equal(printable.langfuse.datasetName, "personal-copilot-live-eval-v4");
  assert.equal(printable.goldenSet.requiredLabelStatus, "human-reviewed");
  assert.equal(printable.goldenSet.evidenceTable, "eval_evidence_snapshots");
  assert.equal(printable.goldenSet.evidenceSchemaVersion, "copilot-eval-evidence.v1");
  assert.equal(printable.goldenSet.sessionBoundary, "through-evaluated-turn");
  assert.match(printable.effectiveFingerprint, /^[a-f0-9]{64}$/u);
});

test("环境变量中的相对配置路径始终相对项目根目录解析", () => {
  const configuration = loadEvalConfiguration({
    env: { COPILOT_EVAL_CONFIG: "./evals/eval.config.json" }
  });
  assert.equal(configuration.configPath, configPath);
});

test("未启用 Judge 时模型覆盖不会改变离线行为指纹", () => {
  const first = loadEvalConfiguration({ configPath, env: {} });
  const second = loadEvalConfiguration({ configPath, env: { COPILOT_EVAL_JUDGE_MODEL: "another/judge" } });
  assert.equal(effectiveConfigurationFingerprint(first), effectiveConfigurationFingerprint(second));
});

test("Web 运行配置中的 Judge 模型会覆盖系统预设并迁移旧配置协议", () => {
  const directory = mkdtempSync(join(tmpdir(), "copilot-eval-runtime-settings-"));
  const runtimeSettingsPath = join(directory, "runtime-settings.json");
  writeFileSync(runtimeSettingsPath, `${JSON.stringify({
    schemaVersion: "copilot-runtime-settings.v1",
    updatedAt: "2026-08-31T00:00:00.000Z",
    values: { COPILOT_EVAL_JUDGE_MODEL: "runtime/judge-model" }
  }, null, 2)}\n`, "utf8");
  const previous = {
    allow: process.env.COPILOT_ALLOW_WEB_CONFIGURATION,
    path: process.env.COPILOT_RUNTIME_CONFIG_PATH,
    judge: process.env.COPILOT_EVAL_JUDGE_MODEL
  };
  try {
    process.env.COPILOT_ALLOW_WEB_CONFIGURATION = "true";
    process.env.COPILOT_RUNTIME_CONFIG_PATH = runtimeSettingsPath;
    delete process.env.COPILOT_EVAL_JUDGE_MODEL;
    const configuration = loadEvalConfiguration({ configPath, profileName: "live-judged" });
    assert.equal(configuration.run.judge.model, "runtime/judge-model");
    persistRuntimeSettings({ path: runtimeSettingsPath, updates: { COPILOT_EVAL_JUDGE_MODEL: "runtime/judge-model-v2" } });
    assert.equal(JSON.parse(readFileSync(runtimeSettingsPath, "utf8")).schemaVersion, "copilot-runtime-settings.v2");
  } finally {
    if (previous.allow === undefined) delete process.env.COPILOT_ALLOW_WEB_CONFIGURATION;
    else process.env.COPILOT_ALLOW_WEB_CONFIGURATION = previous.allow;
    if (previous.path === undefined) delete process.env.COPILOT_RUNTIME_CONFIG_PATH;
    else process.env.COPILOT_RUNTIME_CONFIG_PATH = previous.path;
    if (previous.judge === undefined) delete process.env.COPILOT_EVAL_JUDGE_MODEL;
    else process.env.COPILOT_EVAL_JUDGE_MODEL = previous.judge;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Profile 继承只覆盖差异且保留真实运行安全约束", () => {
  const live = loadEvalConfiguration({ configPath, profileName: "live-judged", env: {} });
  assert.equal(live.run.execution.mode, "live");
  assert.equal(live.run.execution.traceLive, true);
  assert.equal(live.run.selectors.liveEligibleOnly, true);
  assert.equal(live.run.judge.enabled, true);
  assert.deepEqual(live.run.judge.definitionIds, ["intent_semantic_fit", "answer_task_success"]);

  const ci = loadEvalConfiguration({ configPath, profileName: "ci", env: {} });
  assert.equal(ci.run.gate.diagnosticDebtRatchet, true);
  assert.equal(ci.run.gate.minimumCases, 140);
  assert.equal(ci.run.report.output, "results/ci-latest.json");
});

test("环境变量与命令行覆盖具有稳定优先级", () => {
  const configuration = loadEvalConfiguration({
    configPath,
    profileName: "local",
    env: {
      COPILOT_EVAL_JUDGE_MODEL: "provider/judge-model",
      COPILOT_EVAL_OUTPUT_DIRECTORY: "custom-results",
      COPILOT_LANGFUSE_EVAL_DATASET: "copilot-custom-dataset"
    }
  });
  const run = applyRunOverrides(configuration, {
    suites: ["core-routing"],
    judgeModel: "cli/judge-model",
    output: "result.json"
  });
  assert.equal(run.judge.model, "cli/judge-model");
  assert.equal(run.report.directory, "custom-results");
  assert.equal(run.report.output, "result.json");
  assert.equal(configuration.langfuse.datasetName, "copilot-custom-dataset");
  assert.deepEqual(run.selectors.suites, ["core-routing"]);
  const otherOutput = applyRunOverrides(configuration, {
    suites: ["core-routing"],
    judgeModel: "cli/judge-model",
    output: "another-result.json"
  });
  assert.equal(
    effectiveConfigurationFingerprint(configuration, run),
    effectiveConfigurationFingerprint(configuration, otherOutput)
  );
});

test("配置数据集声明版本与多维选择器可以独立验证", () => {
  const configuration = loadEvalConfiguration({ configPath, env: {} });
  const items = loadConfiguredDatasets(configuredDatasets(configuration));
  assert.equal(items.length, 140);
  const selected = selectDatasetItems(items, {
    suites: ["core-routing"],
    risks: ["low"],
    tags: ["research", "direct"]
  });
  assert.ok(selected.length > 0);
  assert.ok(selected.every(item => item.suite === "core-routing" && item.metadata.risk === "low"));
  assert.ok(selected.every(item => item.metadata.tags.some(tag => ["research", "direct"].includes(tag))));
  assert.equal(datasetFingerprint(items), datasetFingerprint([...items].reverse()));
  const changed = structuredClone(items);
  changed[0].input.messages[0].content += "变更";
  assert.notEqual(datasetFingerprint(items), datasetFingerprint(changed));
});

test("真实 Eval 样本不能依赖离线检索 fixture", () => {
  const fixture = {
    id: "fixture-live-search-001",
    suite: "fixture-policy",
    input: {
      messages: [{ role: "user", content: "查询当前状态。" }],
      search_results: [{ title: "fixture", url: "https://status.example/test", content: "ok" }]
    },
    expected: {},
    metadata: {
      dataset_version: "fixture-policy.v1",
      label_status: "specification-derived",
      live_eligible: true
    }
  };
  assert.throws(() => validateDatasetItem(fixture), /不能标记为 live_eligible=true/u);
  fixture.metadata.live_eligible = false;
  assert.doesNotThrow(() => validateDatasetItem(fixture));
});

test("Judge Catalog 可独立版本化并由 Profile 选择", () => {
  const configuration = loadEvalConfiguration({ configPath, profileName: "live-judged", env: {} });
  const definitions = loadJudgeDefinitions(new URL(`../evals/${configuration.run.judge.catalog}`, import.meta.url));
  const selected = selectJudgeDefinitions(configuration.run.judge.definitionIds, definitions);
  assert.deepEqual(selected.map(item => item.id), configuration.run.judge.definitionIds);
  assert.ok(selected.every(item => /^\d+\.\d+\.\d+$/u.test(item.version)));
});

test("配置拒绝循环 Profile 和绕过 blocking 的门禁", () => {
  const directory = mkdtempSync(join(tmpdir(), "copilot-eval-config-test-"));
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    raw.profiles = { first: { extends: "second" }, second: { extends: "first" } };
    const cyclicPath = join(directory, "cyclic.json");
    writeFileSync(cyclicPath, JSON.stringify(raw), "utf8");
    assert.throws(() => loadEvalConfiguration({ configPath: cyclicPath, env: {} }), /循环继承/u);

    const unsafe = JSON.parse(readFileSync(configPath, "utf8"));
    unsafe.defaults.gate.failSeverities = ["diagnostic"];
    const unsafePath = join(directory, "unsafe.json");
    writeFileSync(unsafePath, JSON.stringify(unsafe), "utf8");
    assert.throws(() => loadEvalConfiguration({ configPath: unsafePath, env: {} }), /必须包含 blocking/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("共享 CLI 解析器拒绝缺失值和非整数参数", () => {
  const specification = {
    "--config": { key: "config", type: "string" },
    "--concurrency": { key: "concurrency", type: "integer" },
    "--tag": { key: "tags", type: "string", append: true }
  };
  assert.throws(() => parseCliOptions(["--config"], specification), /缺少值/u);
  assert.throws(() => parseCliOptions(["--concurrency", "2.5"], specification), /必须是整数/u);
  assert.deepEqual(
    parseCliOptions(["--tag", "routing", "--tag", "safety"], specification, { tags: [] }),
    { tags: ["routing", "safety"] }
  );
});
