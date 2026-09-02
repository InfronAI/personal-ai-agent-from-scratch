import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-eval-dataset-catalog-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "copilot.sqlite");

const catalogModule = await import(`../eval-dataset-catalog.mjs?catalog=${Date.now()}`);
const { closeDatabase } = await import("../database.mjs");

after(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("Dataset Catalog 统一呈现专业覆盖、Benchmark 证据与用户反馈生命周期", () => {
  const catalog = catalogModule.evalDatasetCatalog({ userId: "usr-catalog" });
  assert.equal(catalog.schemaVersion, "copilot-eval-dataset-catalog.v2");
  assert.equal(catalog.benchmarkCatalogVersion, "2026-09-01-r2");
  assert.equal(catalog.summary.built_in_items, 140);
  assert.equal(catalog.summary.live_eligible_items, 69);
  assert.equal(catalog.datasets.length, 19);
  assert.equal(catalog.datasets[0].id, "feedback-golden");
  const dimensions = new Set(catalog.datasets.map(dataset => dataset.evaluation_dimension));
  for (const dimension of ["general_knowledge", "vertical_capability", "performance_resilience", "safety_compliance", "agent_capability"]) {
    assert.equal(dimensions.has(dimension), true, dimension);
  }
  assert.equal(catalog.summary.benchmark_families, 27);
  assert.equal(catalog.summary.coverage.workflow_stages.final_answer, 22);
  const research = catalog.datasets.find(dataset => dataset.id === "benchmark-grounded-research");
  assert.deepEqual(research.benchmark_references.map(item => item.id), ["browsecomp", "crag"]);
  assert.equal(research.benchmark_references.every(item => item.official_url.startsWith("https://")), true);
  assert.equal(research.coverage.capabilities.multi_hop_browsing, 1);
  assert.equal(catalog.datasets.every(dataset => !/[\u3400-\u9fff]/u.test(dataset.purpose)), true);
  assert.equal(catalog.datasets.flatMap(dataset => dataset.benchmark_references).every(reference => !/[\u3400-\u9fff]/u.test(reference.scope)), true);
});

test("内置 Dataset API 隐藏离线 Script 与注入 Fixture，只暴露可审核契约", () => {
  const payload = catalogModule.evalDatasetItems({ userId: "usr-catalog", datasetId: "general-knowledge", status: "published" });
  assert.equal(payload.read_only, true);
  assert.equal(payload.items.length, 5);
  assert.equal(payload.items.every(item => item.lifecycle_status === "published"), true);
  assert.equal(payload.items.every(item => !Object.hasOwn(item.input, "script")), true);
  assert.equal(payload.items.every(item => !Object.hasOwn(item.input, "search_results")), true);
  assert.equal(payload.items.every(item => item.metadata.evaluation_dimension === "general_knowledge"), true);
  assert.throws(
    () => catalogModule.evalDatasetItems({ userId: "usr-catalog", datasetId: "unknown-dataset" }),
    error => error.code === "eval_dataset_not_found"
  );
});
