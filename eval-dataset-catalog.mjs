import { AppError } from "./errors.mjs";
import { readFileSync } from "node:fs";
import { configuredDatasets, loadEvalConfiguration } from "./evals/lib/eval-config.mjs";
import { loadConfiguredDatasets } from "./evals/lib/dataset.mjs";
import { feedbackDatasetSummary, listGoldenSetItems } from "./golden-set-store.mjs";

const configuration = loadEvalConfiguration({ profileName: "local" });
const descriptors = configuredDatasets(configuration, Object.keys(configuration.datasets));
const builtInItems = loadConfiguredDatasets(descriptors);
const descriptorById = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]));
const benchmarkCatalog = JSON.parse(readFileSync(new URL("./evals/benchmarks/catalog.v1.json", import.meta.url), "utf8"));
const benchmarkById = new Map(benchmarkCatalog.benchmarks.map(benchmark => [benchmark.id, benchmark]));
const purposeByDatasetId = Object.freeze({
  core: "Core routing, tools, memory, documents, multimodal input, and output contracts",
  multiturn: "Multi-turn context, references, corrections, and language changes",
  adversarial: "Harness, recovery, safety, and policy-boundary adversarial cases",
  "general-knowledge": "Stable knowledge, mathematics, science, history, and constrained language tasks",
  "vertical-capabilities": "Healthcare, software, research, analysis, education, and document capabilities",
  "performance-resilience": "Model, token, tool, context, latency, and recovery budgets",
  "safety-compliance": "Prompt injection, untrusted evidence, high-risk advice, and abuse boundaries",
  "agent-capabilities": "Clarification, memory, tool evidence, artifacts, and multi-turn constraint retention",
  "benchmark-knowledge-reasoning": "MMLU-Pro, GPQA, GSM8K, TruthfulQA, and IFEval methodology adaptations",
  "benchmark-professional-domains": "Healthcare, legal, finance, software, long-context, and multimodal professional tasks",
  "benchmark-agentic": "BFCL, GAIA, and tau-bench methodology adaptations for tool-using agents",
  "benchmark-safety": "HarmBench and XSTest methodology adaptations for refusal calibration",
  "benchmark-grounded-research": "CRAG and BrowseComp methodology adaptations for grounded, multi-hop research",
  "benchmark-memory-personalization": "LongMemEval and LoCoMo methodology adaptations for durable personalized memory",
  "benchmark-multilingual-instruction": "Multi-IF methodology adaptations for multilingual, multi-turn constraints",
  "benchmark-high-stakes-professional": "HealthBench and FinanceBench methodology adaptations for evidence-bound professional work",
  "benchmark-cybersecurity": "CyberSecEval 4 methodology adaptations for abuse boundaries and defensive analysis",
  "benchmark-software-data": "LiveCodeBench, SWE-Lancer, and Spider 2.0 methodology adaptations for software and data work"
});

function counts(values) {
  return Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(candidate => candidate === value).length]));
}

function displayName(id) {
  return id.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function coverage(items) {
  return {
    domains: counts(items.map(item => item.metadata.domain).filter(Boolean)),
    capabilities: counts(items.map(item => item.metadata.capability).filter(Boolean)),
    interaction_patterns: counts(items.map(item => item.metadata.interaction_pattern).filter(Boolean)),
    decision_uses: counts(items.map(item => item.metadata.decision_use).filter(Boolean)),
    workflow_stages: counts(items.map(item => item.metadata.workflow_stage).filter(Boolean))
  };
}

function benchmarkReferences(items) {
  const ids = [...new Set(items.map(item => item.metadata.benchmark_reference_id || item.metadata.benchmark_family).filter(Boolean))].sort();
  return ids.map(id => {
    const benchmark = benchmarkById.get(id);
    return benchmark ? {
      id: benchmark.id,
      name: benchmark.name,
      scope: "Official benchmark methodology reference",
      official_url: benchmark.officialUrl
    } : { id, name: displayName(id), scope: "Benchmark methodology", official_url: null };
  });
}

function safeInput(input) {
  const value = {
    messages: structuredClone(input.messages || [])
  };
  if (input.model) value.model = input.model;
  if (Array.isArray(input.artifact_names)) value.artifact_names = [...input.artifact_names];
  if (Array.isArray(input.memory_seed)) value.memory_seed_count = input.memory_seed.length;
  if (Array.isArray(input.artifact_seed)) value.artifact_seed_count = input.artifact_seed.length;
  return value;
}

function publicBuiltInItem(item) {
  return {
    id: item.id,
    dataset_id: item.datasetId,
    suite: item.suite,
    input: safeInput(item.input),
    expected: structuredClone(item.expected),
    metadata: {
      ...structuredClone(item.metadata),
      evaluation_dimension: item.metadata.evaluation_dimension || item.datasetDimension
    },
    lifecycle_status: "published",
    read_only: true
  };
}

export function evalDatasetCatalog({ userId }) {
  const datasets = descriptors.map(descriptor => {
    const items = builtInItems.filter(item => item.datasetId === descriptor.id);
    return {
      id: descriptor.id,
      name: displayName(descriptor.id),
      version: descriptor.version,
      purpose: purposeByDatasetId[descriptor.id] || displayName(descriptor.id),
      evaluation_dimension: descriptor.dimension,
      source: "built-in",
      lifecycle_status: "published",
      read_only: true,
      item_count: items.length,
      active_count: items.length,
      archived_count: 0,
      candidate_count: 0,
      live_eligible_count: items.filter(item => item.metadata.live_eligible === true).length,
      risks: counts(items.map(item => item.metadata.risk)),
      difficulties: counts(items.map(item => item.metadata.difficulty || "unspecified")),
      benchmarks: counts(items.filter(item => item.metadata.benchmark_family).map(item => item.metadata.benchmark_family)),
      labels: counts(items.map(item => item.metadata.label_status)),
      coverage: coverage(items),
      benchmark_references: benchmarkReferences(items)
    };
  });
  const feedback = feedbackDatasetSummary({ userId });
  datasets.unshift({
    id: "feedback-golden",
    name: "Feedback Golden Set",
    version: configuration.goldenSet.export.datasetVersion,
    purpose: "Human-reviewed feedback promoted into reproducible regression data",
    evaluation_dimension: "user_feedback",
    source: "user-feedback",
    lifecycle_status: "active",
    read_only: false,
    item_count: feedback.active + feedback.archived,
    active_count: feedback.active,
    archived_count: feedback.archived,
    candidate_count: feedback.candidates,
    live_eligible_count: feedback.active,
    risks: {},
    difficulties: {},
    benchmarks: {},
    labels: { "human-reviewed": feedback.active + feedback.archived },
    coverage: { domains: {}, capabilities: {}, interaction_patterns: {}, decision_uses: {}, workflow_stages: {} },
    benchmark_references: []
  });
  return {
    schemaVersion: "copilot-eval-dataset-catalog.v2",
    benchmarkCatalogVersion: benchmarkCatalog.catalogVersion,
    datasets,
    summary: {
      datasets: datasets.length,
      built_in_items: builtInItems.length,
      feedback_active: feedback.active,
      feedback_archived: feedback.archived,
      feedback_candidates: feedback.candidates,
      benchmark_families: new Set(builtInItems.map(item => item.metadata.benchmark_family).filter(Boolean)).size,
      live_eligible_items: builtInItems.filter(item => item.metadata.live_eligible === true).length + feedback.active,
      coverage: coverage(builtInItems)
    },
    lifecycle: ["candidate", "human_review", "active", "archived"]
  };
}

export function evalDatasetItems({ userId, datasetId, status = "active" }) {
  if (datasetId === "feedback-golden") {
    return {
      dataset_id: datasetId,
      read_only: false,
      status,
      items: listGoldenSetItems({ userId, status })
    };
  }
  if (!descriptorById.has(datasetId)) {
    throw new AppError("Eval Dataset 不存在", { code: "eval_dataset_not_found", status: 404, expose: true });
  }
  return {
    dataset_id: datasetId,
    read_only: true,
    status: "published",
    items: builtInItems.filter(item => item.datasetId === datasetId).map(publicBuiltInItem)
  };
}

export function evalDatasetCatalogStatus() {
  return {
    configured: true,
    schemaVersion: "copilot-eval-dataset-catalog.v2",
    benchmarkCatalogVersion: benchmarkCatalog.catalogVersion,
    builtInDatasets: descriptors.length,
    builtInItems: builtInItems.length
  };
}
