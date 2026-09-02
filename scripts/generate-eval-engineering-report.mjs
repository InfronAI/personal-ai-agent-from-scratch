import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "../..");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const offlinePath = resolve(projectRoot, option("--offline", "evals/results/domain-benchmark-expansion-offline-2026-09-01.json"));
const livePath = resolve(projectRoot, option("--live", "evals/results/domain-benchmark-expansion-live-judged-2026-09-01.json"));
const outputRoot = resolve(workspaceRoot, option("--output", "export/personal_copilot_domain_benchmark_eval_2026-09-01"));
const assetsRoot = join(outputRoot, "assets");
if (!existsSync(offlinePath)) throw new Error(`离线 Eval 结果不存在：${offlinePath}`);
if (!existsSync(livePath)) throw new Error(`真实 Eval 结果不存在：${livePath}`);

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const jsonLines = path => readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const offline = readJson(offlinePath);
const live = readJson(livePath);
const configuration = readJson(resolve(projectRoot, "evals/eval.config.json"));
const benchmarkCatalog = readJson(resolve(projectRoot, "evals/benchmarks/catalog.v1.json"));
const items = Object.entries(configuration.datasets).flatMap(([datasetId, descriptor]) => jsonLines(resolve(projectRoot, "evals", descriptor.file)).map(item => ({ ...item, datasetId, datasetDimension: descriptor.dimension })));
const itemById = new Map(items.map(item => [item.id, item]));
const liveEligibleCount = items.filter(item => item.metadata.live_eligible === true).length;
const benchmarkInspiredCount = items.filter(item => item.metadata.benchmark_family).length;

function ratio(numerator, denominator, digits = 1) {
  return denominator ? `${(numerator / denominator * 100).toFixed(digits)}%` : "—";
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s` : `${Math.round(value)} ms`;
}

function countBy(values) {
  return Object.fromEntries([...new Set(values.filter(Boolean))].sort().map(value => [value, values.filter(candidate => candidate === value).length]));
}

function html(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function md(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

const liveTimes = live.cases.map(item => item.wallTimeMs).filter(Number.isFinite);
const latency = {
  p50: percentile(liveTimes, 0.5), p90: percentile(liveTimes, 0.9),
  p95: percentile(liveTimes, 0.95), max: percentile(liveTimes, 1)
};
const strictCasePass = live.cases.filter(item => item.status === "pass").length;
const offlineGatePass = offline.summary.checks.failed === 0 && offline.summary.checks.errors === 0;
const strictGatePass = strictCasePass === live.summary.cases && live.summary.checks.blockingFailures === 0 && live.summary.checks.errors === 0;
const judgeIds = ["intent_semantic_fit", "answer_task_success"];
const judgeSummary = Object.fromEntries(judgeIds.map(evaluator => {
  const checks = live.checks.filter(check => check.evaluator === evaluator);
  return [evaluator, { total: checks.length, pass: checks.filter(check => check.status === "pass").length, fail: checks.filter(check => check.status === "fail").length, error: checks.filter(check => check.status === "error").length }];
}));
const checksByCase = new Map(live.cases.map(item => [item.id, live.checks.filter(check => check.scopeId === item.id)]));
const judgeFor = (id, evaluator) => (checksByCase.get(id) || []).find(check => check.evaluator === evaluator);

const dimensionLabels = {
  product_contract: { zh: "产品契约", en: "Product contract" },
  general_knowledge: { zh: "通用知识", en: "General knowledge" },
  vertical_capability: { zh: "垂直场景能力", en: "Vertical capability" },
  performance_resilience: { zh: "性能与韧性", en: "Performance & resilience" },
  safety_compliance: { zh: "安全合规", en: "Safety & compliance" },
  agent_capability: { zh: "Agent 通用能力", en: "Agent capability" }
};
const englishPurpose = {
  core: "Core routing, memory, artifacts, multimodal input, model selection, and output contracts",
  multiturn: "History, corrections, references, and session continuity",
  adversarial: "Invalid routes, budgets, recovery, and policy boundaries",
  "general-knowledge": "Math, science, history, probability, and constrained transformation",
  "vertical-capabilities": "Healthcare, software, finance, business, education, and documents",
  "performance-resilience": "Calls, tokens, tools, retrieval, context, and recovery budgets",
  "safety-compliance": "Prompt leakage, injection, financial risk, and phishing abuse",
  "agent-capabilities": "Clarification, memory grounding, evidence, and multi-tool work",
  "benchmark-knowledge-reasoning": "MMLU-Pro, GPQA, GSM8K, TruthfulQA, and IFEval methods",
  "benchmark-professional-domains": "PubMedQA, LegalBench, FinQA, SWE-bench, LongBench, and MMMU methods",
  "benchmark-agentic": "BFCL, GAIA, and tau-bench methods",
  "benchmark-safety": "HarmBench and XSTest methods",
  "benchmark-grounded-research": "CRAG and BrowseComp grounded-research methods",
  "benchmark-memory-personalization": "LongMemEval and LoCoMo memory methods",
  "benchmark-multilingual-instruction": "Multi-IF multilingual instruction methods",
  "benchmark-high-stakes-professional": "HealthBench and FinanceBench professional methods",
  "benchmark-cybersecurity": "CyberSecEval 4 safety and defensive-task methods",
  "benchmark-software-data": "LiveCodeBench, SWE-Lancer, and Spider 2.0 methods"
};
const datasetRows = Object.entries(configuration.datasets).map(([id, descriptor]) => {
  const matching = items.filter(item => item.datasetId === id);
  return { id, version: descriptor.version, dimension: descriptor.dimension, total: matching.length, live: matching.filter(item => item.metadata.live_eligible === true).length, zh: descriptor.purpose, en: englishPurpose[id] || id };
});
const offlineOnlyDatasetIds = datasetRows.filter(row => row.live === 0).map(row => row.id);
const dimensionRows = [...new Set(items.map(item => item.datasetDimension))].map(dimension => {
  const all = items.filter(item => item.datasetDimension === dimension);
  const cases = live.cases.filter(item => itemById.get(item.id)?.datasetDimension === dimension);
  const intent = cases.map(item => judgeFor(item.id, "intent_semantic_fit")).filter(Boolean);
  const answer = cases.map(item => judgeFor(item.id, "answer_task_success")).filter(Boolean);
  return { dimension, total: all.length, live: cases.length, strictPass: cases.filter(item => item.status === "pass").length, intentPass: intent.filter(check => check.status === "pass").length, intentTotal: intent.length, answerPass: answer.filter(check => check.status === "pass").length, answerTotal: answer.length, p50: percentile(cases.map(item => item.wallTimeMs), 0.5) };
});
const modelRows = [...new Set(live.cases.map(item => item.resolvedModel || "unresolved"))].map(model => {
  const cases = live.cases.filter(item => (item.resolvedModel || "unresolved") === model);
  const answer = cases.map(item => judgeFor(item.id, "answer_task_success")).filter(Boolean);
  return { model, cases: cases.length, strictPass: cases.filter(item => item.status === "pass").length, answerPass: answer.filter(check => check.status === "pass").length, answerTotal: answer.length, p50: percentile(cases.map(item => item.wallTimeMs), 0.5), p95: percentile(cases.map(item => item.wallTimeMs), 0.95) };
}).sort((left, right) => right.cases - left.cases || left.model.localeCompare(right.model));

const familyCounts = countBy(items.map(item => item.metadata.benchmark_family));
const benchmarkRows = benchmarkCatalog.benchmarks.map(benchmark => ({ ...benchmark, cases: familyCounts[benchmark.id] || 0 })).filter(benchmark => benchmark.cases);
const workflowCounts = countBy(items.map(item => item.metadata.workflow_stage));
const workflowStages = [
  { zh: "输入与上下文", en: "Input & context", keys: ["input_context"] },
  { zh: "Intent routing", en: "Intent routing", keys: ["intent_routing"] },
  { zh: "Agent 与 Tool", en: "Agent & tools", keys: ["agent_routing", "agent_tools"] },
  { zh: "最终回答", en: "Final answer", keys: ["final_answer"] },
  { zh: "Memory 与 Safety", en: "Memory & safety", keys: ["memory", "safety"] }
].map(stage => ({ ...stage, count: stage.keys.reduce((sum, key) => sum + (workflowCounts[key] || 0), 0) }));
const workflowTagged = Object.values(workflowCounts).reduce((sum, value) => sum + value, 0);
const failedChecks = live.checks.filter(check => check.status !== "pass");
const failedCases = live.cases.filter(item => item.status !== "pass");
const signalAffectedCases = new Set(failedChecks.map(check => check.scopeId)).size;
const signalFailureRows = [...new Set(failedChecks.map(check => check.evaluator))].map(evaluator => {
  const checks = failedChecks.filter(check => check.evaluator === evaluator);
  return { evaluator, cases: new Set(checks.map(check => check.scopeId)).size, signals: checks.length, blocking: checks.filter(check => check.severity === "blocking").length, errors: checks.filter(check => check.status === "error").length };
}).sort((left, right) => right.blocking - left.blocking || right.signals - left.signals);
function failureCategory(evaluator) {
  if (evaluator === "scenario_execution") return "execution_reliability";
  if (evaluator.startsWith("performance_")) return "runtime_budget";
  if (evaluator === "intent_semantic_fit" || evaluator === "answer_task_success") return "semantic_judge";
  if (evaluator.startsWith("route_") || evaluator.includes("transfer_to_agent")) return "routing_contract";
  if (evaluator.startsWith("tool_") || evaluator.startsWith("trace_kind_")) return "tool_trace_contract";
  if (evaluator.startsWith("answer_")) return "answer_contract";
  return "other_contract";
}
const failureCategoryRows = [...new Set(failedChecks.map(check => failureCategory(check.evaluator)))].map(category => {
  const checks = failedChecks.filter(check => failureCategory(check.evaluator) === category);
  return { category, cases: new Set(checks.map(check => check.scopeId)).size, signals: checks.length, blocking: checks.filter(check => check.severity === "blocking").length, errors: checks.filter(check => check.status === "error").length };
}).sort((left, right) => right.blocking - left.blocking || right.signals - left.signals);
const categoryMetric = category => failureCategoryRows.find(row => row.category === category) || { cases: 0, signals: 0, blocking: 0, errors: 0 };
const strictSemanticGap = Math.max(0, judgeSummary.answer_task_success.pass - strictCasePass);
const executionErrorCases = live.cases.filter(item => item.error).length;
const judgeConsistencyCandidates = failedChecks.filter(check =>
  ["intent_semantic_fit", "answer_task_success"].includes(check.evaluator)
  && /\b(correctly|adheres|matches|fulfills|meets)\b|aligning with safety/iu.test(check.reason || "")
);
const categoryLabels = {
  routing_contract: { zh: "路由与委派契约", en: "Routing & delegation contract" },
  answer_contract: { zh: "回答内容与格式契约", en: "Answer content & format contract" },
  tool_trace_contract: { zh: "工具与 Trace 契约", en: "Tool & trace contract" },
  runtime_budget: { zh: "时延、调用与 Token 预算", en: "Latency, call & token budgets" },
  execution_reliability: { zh: "执行可靠性", en: "Execution reliability" },
  semantic_judge: { zh: "语义 Judge（诊断）", en: "Semantic judge (diagnostic)" },
  other_contract: { zh: "其他工程契约", en: "Other engineering contracts" }
};
const slowest = [...live.cases].filter(item => Number.isFinite(item.wallTimeMs)).sort((left, right) => right.wallTimeMs - left.wallTimeMs).slice(0, 10);

function mdProgress(numerator, denominator) {
  const filled = denominator ? Math.round(numerator / denominator * 12) : 0;
  return `${"█".repeat(filled)}${"░".repeat(12 - filled)} ${ratio(numerator, denominator)}`;
}

function bar(numerator, denominator) {
  const width = denominator ? Math.max(0, Math.min(100, numerator / denominator * 100)) : 0;
  return `<div class="bar"><span><i style="width:${width}%"></i></span><b>${ratio(numerator, denominator)}</b><small>${numerator}/${denominator}</small></div>`;
}

function verdict(language) {
  const zh = language === "zh";
  if (strictGatePass) return zh
    ? `${offline.summary.cases} 条离线回归与 ${live.summary.cases} 条真实评测均满足严格工程门禁；LLM Judge 仍应作为诊断信号，待人工 Golden 校准后再升级为发布门禁。`
    : `All ${offline.summary.cases} offline regressions and ${live.summary.cases} live evaluations meet the strict engineering gate. LLM-judge results remain diagnostic until calibrated against human-reviewed Golden labels.`;
  return zh
    ? `${offline.summary.cases} 条离线回归已通过；${live.summary.cases} 条真实评测中 ${strictCasePass} 条满足全部严格契约。真实门禁尚未通过，需关闭 ${live.summary.checks.blockingFailures} 个阻断信号与 ${live.summary.checks.errors} 个执行错误。`
    : `The ${offline.summary.cases}-case offline regression passes. ${strictCasePass} of ${live.summary.cases} live cases satisfy every strict contract; ${live.summary.checks.blockingFailures} blocking signals and ${live.summary.checks.errors} execution errors remain.`;
}

function markdown(language) {
  const zh = language === "zh";
  const lines = [
    `# ${zh ? "Personal Copilot Domain Benchmark Eval 报告" : "Personal Copilot Domain Benchmark Eval Report"}`,
    "", `> ${zh ? "行业 Benchmark 方法扩展、Eval Dataset 产品化与完整回归" : "Domain-benchmark expansion, Eval Dataset productization, and complete regression"} · 2026-09-01`, "",
    `## ${zh ? "核心结论" : "Core verdict"}`, "", verdict(language), "",
    `## ${zh ? "0. 执行摘要" : "0. Executive summary"}`, "",
    `- ${zh ? "离线工程门禁" : "Offline engineering gate"}: ${offlineGatePass ? "PASS" : "FAIL"} · ${offline.summary.cases} Cases · ${offline.summary.checks.passed}/${offline.summary.checks.total} checks.`,
    `- ${zh ? "真实严格门禁" : "Live strict gate"}: ${strictGatePass ? "PASS" : "FAIL"} · ${strictCasePass}/${live.summary.cases} Cases · ${live.summary.checks.blockingFailures} blocking · ${live.summary.checks.errors} errors.`,
    `- Intent Judge: ${judgeSummary.intent_semantic_fit.pass}/${judgeSummary.intent_semantic_fit.total} (${ratio(judgeSummary.intent_semantic_fit.pass, judgeSummary.intent_semantic_fit.total)}); Answer Judge: ${judgeSummary.answer_task_success.pass}/${judgeSummary.answer_task_success.total} (${ratio(judgeSummary.answer_task_success.pass, judgeSummary.answer_task_success.total)}).`,
    `- ${zh ? "性能" : "Performance"}: P50 ${formatMs(latency.p50)} · P95 ${formatMs(latency.p95)} · Max ${formatMs(latency.max)}.`,
    `- ${zh ? "覆盖" : "Coverage"}: ${datasetRows.length} Datasets · ${items.length} Cases · ${benchmarkInspiredCount} benchmark-inspired original cases · ${benchmarkRows.length} methods · ${liveEligibleCount} live-eligible.`, "",
    `### ${zh ? "结果解读" : "Result interpretation"}`, "",
    zh ? `- Answer Judge 通过数比严格 Case 通过数高 ${strictSemanticGap} 条，说明主要缺口不只在回答语义，还集中在路由、工具、格式和资源预算契约。` : `Answer-judge passes exceed strict case passes by ${strictSemanticGap}, showing that gaps are concentrated not only in answer semantics but also in routing, tools, formatting, and resource budgets.`,
    zh ? `- 路由与委派层产生 ${categoryMetric("routing_contract").signals} 个非通过信号，影响 ${categoryMetric("routing_contract").cases} 个 Case；这是当前最应先修的架构层。` : `Routing and delegation produced ${categoryMetric("routing_contract").signals} non-passing signals across ${categoryMetric("routing_contract").cases} cases, making it the first architectural layer to address.`,
    zh ? `- 资源预算层产生 ${categoryMetric("runtime_budget").signals} 个非通过信号；${executionErrorCases} 个 Case 出现执行错误。P95 与 Max 表明尾延迟需要独立治理。` : `Runtime budgets produced ${categoryMetric("runtime_budget").signals} non-passing signals, and ${executionErrorCases} cases had execution errors. P95 and max latency require dedicated tail-latency work.`,
    zh ? `- ${offlineOnlyDatasetIds.join("、")} 当前只有离线 fixture 覆盖；补充可复现的真实证据源之前，不应对其宣称线上能力结论。` : `The ${offlineOnlyDatasetIds.join(", ")} datasets currently have offline-fixture coverage only; no live capability claim should be made until reproducible evidence sources are added.`,
    zh ? `- 两个 Strict JSON Judge 均未经过人工 Golden 校准；本轮发现 ${judgeConsistencyCandidates.length} 个“失败 Verdict 但理由偏正向”的一致性候选，必须人工复核。` : `Both strict-JSON judges remain uncalibrated against human Golden labels; this run contains ${judgeConsistencyCandidates.length} consistency candidates with a failing verdict but a positive rationale, requiring human review.`, "",
    `## ${zh ? "1. 与产品主链路一致的覆盖" : "1. Coverage aligned with the product path"}`, "",
    zh ? `40 条新增 Case 显式标注工作流阶段；旧有 ${items.length - workflowTagged} 条仍可执行，但需要补齐同一元数据。` : `The 40 new cases explicitly tag a workflow stage. The earlier ${items.length - workflowTagged} remain executable but need the same metadata.`, "",
    `| # | ${zh ? "工作流阶段" : "Workflow stage"} | ${zh ? "显式标注 Case" : "Explicit tags"} |`, "|---:|---|---:|",
    ...workflowStages.map((stage, index) => `| ${index + 1} | ${stage[language]} | ${stage.count} |`), "",
    `## ${zh ? "2. Dataset 清单" : "2. Dataset inventory"}`, "",
    `| Dataset | ${zh ? "维度" : "Dimension"} | ${zh ? "总量" : "Total"} | Live | ${zh ? "重点" : "Purpose"} |`, "|---|---|---:|---:|---|",
    ...datasetRows.map(row => `| ${row.id} | ${dimensionLabels[row.dimension]?.[language] || row.dimension} | ${row.total} | ${row.live} | ${md(row[language])} |`), "",
    `## ${zh ? "3. 分层结果" : "3. Layered result"}`, "",
    `| ${zh ? "维度" : "Dimension"} | ${zh ? "内置" : "Built-in"} | Live | ${zh ? "严格通过" : "Strict pass"} | Intent | Answer | P50 |`, "|---|---:|---:|---|---|---|---:|",
    ...dimensionRows.map(row => `| ${dimensionLabels[row.dimension]?.[language] || row.dimension} | ${row.total} | ${row.live} | ${mdProgress(row.strictPass, row.live)} | ${mdProgress(row.intentPass, row.intentTotal)} | ${mdProgress(row.answerPass, row.answerTotal)} | ${formatMs(row.p50)} |`), "",
    `### ${zh ? "按实际回答模型" : "By resolved answer model"}`, "",
    `| Model | Cases | ${zh ? "严格通过" : "Strict pass"} | Answer | P50 | P95 |`, "|---|---:|---|---|---:|---:|",
    ...modelRows.map(row => `| ${md(row.model)} | ${row.cases} | ${mdProgress(row.strictPass, row.cases)} | ${mdProgress(row.answerPass, row.answerTotal)} | ${formatMs(row.p50)} | ${formatMs(row.p95)} |`), "",
    `## ${zh ? "4. 失败与尾延迟下钻" : "4. Failure and tail-latency drill-down"}`, "",
    failedChecks.length ? (zh ? `${failedChecks.length} 个非通过信号分布在 ${signalAffectedCases} 个真实 Case；其中 ${failedCases.length} 个未满足严格门禁。` : `${failedChecks.length} non-passing signals occur across ${signalAffectedCases} live cases; ${failedCases.length} of those cases fail the strict gate.`) : (zh ? "真实运行没有非通过信号。" : "The live run contains no non-passing signals."), "",
    `| ${zh ? "失败层" : "Failure layer"} | Cases | Signals | Blocking | Errors |`, "|---|---:|---:|---:|---:|",
    ...(failureCategoryRows.length ? failureCategoryRows.map(row => `| ${categoryLabels[row.category]?.[language] || row.category} | ${row.cases} | ${row.signals} | ${row.blocking} | ${row.errors} |`) : ["| — | 0 | 0 | 0 | 0 |"]), "",
    `### ${zh ? "高频具体信号" : "Top individual signals"}`, "",
    `| Evaluator | Cases | Signals | Blocking |`, "|---|---:|---:|---:|",
    ...(signalFailureRows.length ? signalFailureRows.slice(0, 12).map(row => `| ${row.evaluator} | ${row.cases} | ${row.signals} | ${row.blocking} |`) : ["| — | 0 | 0 | 0 |"]), "",
    `### ${zh ? "Judge 一致性复核候选" : "Judge consistency review candidates"}`, "",
    `| Case | Judge | Score | ${zh ? "理由摘要" : "Rationale"} |`, "|---|---|---:|---|",
    ...(judgeConsistencyCandidates.length ? judgeConsistencyCandidates.map(row => `| ${row.scopeId} | ${row.evaluator} | ${row.score} | ${md(row.reason)} |`) : ["| — | — | — | — |"]), "",
    `| # | Case | Model | Agent | E2E | Status |`, "|---:|---|---|---|---:|---|",
    ...slowest.map((row, index) => `| ${index + 1} | ${row.id} | ${md(row.resolvedModel || "—")} | ${md(row.specialist || "direct")} | ${formatMs(row.wallTimeMs)} | ${row.status} |`), "",
    `## ${zh ? "5. Eval 工程判断与行动" : "5. Eval-engineering judgment and actions"}`, "",
    ...(zh ? ["1. 优先收敛 Intent routing 与 Agent routing 的委派策略：简单稳定问答不得过度委派，专业任务不得漏派。","2. 将字面 `must_include` 从主质量指标降为协议诊断，核心业务成功改用人工校准的语义 Rubric。","3. 用双人审核的 Feedback Golden Set 校准 Judge，按领域、风险和任务建立混淆矩阵后再升级为阻断门禁。","4. 单独治理模型调用、Tool 执行和 Token 放大，并对超时 Case 建立可复现的 Trace 下钻。","5. 为旧有 Case 补齐 `workflow_stage`，从真实用户反馈持续采样产品分布；真实检索样本不得依赖离线 fixture。","6. 对 live run 至少重复三次，报告 P50/P95 与置信区间。"] : ["1. Converge intent and agent routing first: simple stable questions must not be over-delegated, while specialist tasks must not be under-delegated.","2. Demote literal `must_include` checks to contract diagnostics and use human-calibrated semantic rubrics for business success.","3. Calibrate judges against dual-reviewed Feedback Golden labels and build confusion matrices by domain, risk, and task before making them blocking.","4. Govern model-call, tool-execution, and token amplification separately, with reproducible trace drill-downs for deadline cases.","5. Backfill `workflow_stage`, continuously sample real product traffic, and never let live retrieval cases depend on offline fixtures.","6. Repeat live runs at least three times and report P50/P95 with confidence intervals."]), "",
    `## ${zh ? "6. 方法来源与边界" : "6. Method sources and boundaries"}`, "",
    zh ? "项目只复用公开 Benchmark 的能力定义、任务形态和评分思想；题目、上下文与期望答案均为原创，因此结果不是官方 Benchmark 分数。LLM Judge 在人工校准前仍是诊断信号。" : "Only public benchmark capability definitions, task shapes, and scoring ideas are reused. Questions, contexts, and expected answers are original, so these are not official benchmark scores. LLM judges remain diagnostic until human calibration.", "",
    `| Benchmark | Cases | ${zh ? "官方来源" : "Official source"} |`, "|---|---:|---|",
    ...benchmarkRows.map(row => `| ${row.name} | ${row.cases} | ${row.officialUrl} |`), "",
    `## ${zh ? "7. 证据与复现" : "7. Evidence and reproduction"}`, "",
    `- Offline run: \`${offline.runId}\``, `- Live run: \`${live.runId}\``,
    `- Dataset fingerprint: \`${offline.dataset.fingerprint}\``, `- Config fingerprint: \`${offline.configuration.effectiveFingerprint}\``,
    `- Offline result: \`${offlinePath}\``, `- Live result: \`${livePath}\``,
    "- Langfuse: https://langfuse.com/academy/datasets · https://langfuse.com/academy/evaluate/choosing-what-to-evaluate · https://langfuse.com/academy/evaluate/writing-evaluators", ""
  ];
  return lines.join("\n");
}

function htmlReport(language) {
  const zh = language === "zh";
  const datasetTable = datasetRows.map(row => `<tr><td><code>${html(row.id)}</code><small>${html(row.version)}</small></td><td>${html(dimensionLabels[row.dimension]?.[language] || row.dimension)}</td><td>${row.total}</td><td>${row.live}</td><td>${html(row[language])}</td></tr>`).join("");
  const dimensionTable = dimensionRows.map(row => `<tr><td>${html(dimensionLabels[row.dimension]?.[language] || row.dimension)}</td><td>${row.total}</td><td>${row.live}</td><td>${bar(row.strictPass, row.live)}</td><td>${bar(row.intentPass, row.intentTotal)}</td><td>${bar(row.answerPass, row.answerTotal)}</td><td>${formatMs(row.p50)}</td></tr>`).join("");
  const modelTable = modelRows.map(row => `<tr><td><code>${html(row.model)}</code></td><td>${row.cases}</td><td>${bar(row.strictPass, row.cases)}</td><td>${bar(row.answerPass, row.answerTotal)}</td><td>${formatMs(row.p50)}</td><td>${formatMs(row.p95)}</td></tr>`).join("");
  const failureTable = failureCategoryRows.length ? failureCategoryRows.map(row => `<tr><td>${html(categoryLabels[row.category]?.[language] || row.category)}</td><td>${row.cases}</td><td>${row.signals}</td><td>${row.blocking}</td><td>${row.errors}</td></tr>`).join("") : "<tr><td>—</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>";
  const signalTable = signalFailureRows.length ? signalFailureRows.slice(0, 12).map(row => `<tr><td><code>${html(row.evaluator)}</code></td><td>${row.cases}</td><td>${row.signals}</td><td>${row.blocking}</td></tr>`).join("") : "<tr><td>—</td><td>0</td><td>0</td><td>0</td></tr>";
  const judgeConsistencyTable = judgeConsistencyCandidates.length ? judgeConsistencyCandidates.map(row => `<tr><td><code>${html(row.scopeId)}</code></td><td><code>${html(row.evaluator)}</code></td><td>${row.score}</td><td>${html(row.reason)}</td></tr>`).join("") : "<tr><td>—</td><td>—</td><td>—</td><td>—</td></tr>";
  const slowTable = slowest.map((row, index) => `<tr><td>${index + 1}</td><td><code>${html(row.id)}</code></td><td><code>${html(row.resolvedModel || "—")}</code></td><td>${html(row.specialist || "direct")}</td><td>${formatMs(row.wallTimeMs)}</td><td><span class="status ${row.status === "pass" ? "success" : row.status === "error" ? "danger" : "warning"}">${html(row.status)}</span></td></tr>`).join("");
  const sourceTable = benchmarkRows.map(row => `<tr><td><a href="${html(row.officialUrl)}">${html(row.name)}</a><small>${zh ? html(row.scope) : html(row.id)}</small></td><td>${row.cases}</td></tr>`).join("");
  const actions = zh ? ["优先收敛 Intent routing 与 Agent routing 的委派策略。","将字面匹配降为协议诊断，用人工校准语义 Rubric 衡量业务成功。","用双人审核 Feedback Golden Set 校准 Judge，并按切片建立混淆矩阵。","单独治理模型调用、Tool 执行和 Token 放大，并下钻超时 Trace。","补齐 workflow_stage、持续采样真实产品分布，禁止真实检索样本依赖离线 fixture。","至少重复三次 live run，报告 P50/P95 与置信区间。"] : ["Converge intent and agent routing first.","Demote literal matching to contract diagnostics and use human-calibrated semantic rubrics for business success.","Calibrate judges against dual-reviewed Feedback Golden labels and build sliced confusion matrices.","Govern model calls, tool executions, and token amplification separately, with trace drill-downs for timeouts.","Backfill workflow_stage, sample real product traffic, and keep offline fixtures out of live retrieval cases.","Repeat live runs at least three times and report P50/P95 with confidence intervals."];
  return `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${zh ? "Personal Copilot Domain Benchmark Eval 报告" : "Personal Copilot Domain Benchmark Eval Report"}</title><style>
@font-face{font-family:General Sans;src:url(assets/GeneralSans-Regular.woff2)}@font-face{font-family:General Sans;src:url(assets/GeneralSans-Semibold.woff2);font-weight:600}@font-face{font-family:Gelasio;src:url(assets/Gelasio-Medium.ttf);font-weight:500}@page{size:A4;margin:14mm 13mm 16mm;@bottom-left{content:"Personal Copilot · Evaluation Report";font:9px "General Sans";color:#6E7A8A}@bottom-right{content:counter(page) " / " counter(pages);font:9px "General Sans";color:#6E7A8A}}*{box-sizing:border-box}body{margin:0;background:#F6F9FD;color:#16181C;font-family:"General Sans",Arial,sans-serif;font-size:13px;line-height:1.55}main{max-width:1120px;margin:auto;padding:34px}.hero{position:relative;overflow:hidden;border-radius:22px;padding:28px 30px;color:white;background:linear-gradient(140deg,#002461,#004AB9 58%,#0040FF);box-shadow:0 18px 48px rgba(0,55,138,.18)}.hero:after{content:"";position:absolute;width:420px;height:420px;border:1px solid rgba(255,255,255,.2);border-radius:50%;right:-180px;top:-220px}.report-brand{display:inline-flex;align-items:center;gap:9px;margin-bottom:34px;font-size:15px;font-weight:600}.report-brand i{position:relative;width:28px;height:28px;border:1px solid rgba(255,255,255,.48);border-radius:8px}.report-brand i:before,.report-brand i:after{content:"";position:absolute;left:7px;width:12px;height:5px;border:1.7px solid white;border-radius:5px}.report-brand i:before{top:7px}.report-brand i:after{top:14px}.eyebrow{display:block;letter-spacing:.16em;font-size:10px;font-weight:600;opacity:.75}.hero h1{font:42px/1.03 Gelasio,serif;margin:9px 0 10px}.hero h1 em{color:#C2D8FF;font-weight:400}.hero p{margin:0;color:#E6F0FF}.hero-meta{margin-top:24px;display:flex;gap:18px;font-size:10px;text-transform:uppercase}.verdict{margin:20px 0;padding:18px 20px;border:1px solid #C2D8FF;border-radius:16px;background:white;display:grid;grid-template-columns:115px 1fr;gap:16px}.verdict b{color:#004AB9;text-transform:uppercase;letter-spacing:.1em;font-size:11px}.verdict p{margin:0;font:19px/1.45 Gelasio,serif}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:18px 0}.stat{background:white;border:1px solid #E5EDF9;border-radius:16px;padding:15px;min-height:110px}.stat span{display:block;color:#6E7A8A;font-size:9px;text-transform:uppercase}.stat strong{display:block;color:#004AB9;font:28px/1 Gelasio,serif;margin:12px 0 8px}.stat small{color:#5E5E5E;font-size:9px}.section{background:white;border:1px solid #E5EDF9;border-radius:16px;padding:22px;margin:16px 0}.section h2{font:28px/1.15 Gelasio,serif;margin:0 0 8px;color:#002461}.section h3{font:20px/1.25 Gelasio,serif;color:#004AB9;margin:24px 0 8px}.lead{color:#5E5E5E;margin:0 0 16px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.finding{border:1px solid #D8E2F0;border-radius:12px;padding:14px;break-inside:avoid}.finding b{display:block;color:#004AB9;margin-bottom:4px}.finding p{margin:0}.flow{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:16px 0}.flow div{background:#F1F5FB;border-radius:12px;padding:12px}.flow b{display:block;color:#0040FF;font-size:10px}.flow strong{display:block;margin-top:6px}.flow small{color:#6E7A8A}.callout{border-left:4px solid #0040FF;background:#EBF1FF;padding:12px 14px;margin:12px 0;border-radius:0 8px 8px 0}.callout.warning{border-color:#A87400;background:#FBF1DD}.callout.danger{border-color:#D14343;background:#FBE9E9}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:10.5px}th{text-align:left;color:#173A78;background:#EAF0F8;font-weight:600}th,td{padding:8px;border-bottom:1px solid #E5EDF9;vertical-align:top}tr{break-inside:avoid}td small{display:block;color:#6E7A8A;margin-top:2px}code{font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:#00378A;overflow-wrap:anywhere}.bar{min-width:118px;display:grid;grid-template-columns:minmax(45px,1fr) 38px 32px;gap:5px;align-items:center}.bar>span{height:6px;border-radius:999px;background:#E5EDF9;overflow:hidden}.bar i{display:block;height:100%;background:#0040FF;border-radius:999px}.bar b,.bar small{font-size:8px}.status{display:inline-block;padding:3px 7px;border-radius:99px;font-size:9px}.status.success{background:#E7F6EF;color:#0F7A4F}.status.warning{background:#FBF1DD;color:#8A5D00}.status.danger{background:#FBE9E9;color:#C13030}a{color:#004AB9;text-decoration:none}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;overflow-wrap:anywhere}.page-break{break-before:page}li{margin:6px 0}@media(max-width:760px){main{padding:14px}.stats{grid-template-columns:1fr 1fr}.grid2,.flow{grid-template-columns:1fr}.hero h1{font-size:34px}.verdict{grid-template-columns:1fr}.section{overflow-x:auto}}@media print{body{background:white}main{padding:0}.hero,.section,.stat,.verdict{box-shadow:none}.stats,.flow{break-inside:avoid}}
</style></head><body><main><section class="hero"><div class="report-brand"><i aria-hidden="true"></i><span>Personal Copilot</span></div><span class="eyebrow">EVALUATION ENGINEERING · 2026-09-01</span><h1>${zh ? "从行业方法到<em>产品证据</em>" : "From domain methods to <em>product evidence</em>"}</h1><p>${zh ? "行业 Benchmark 方法扩展、Eval Dataset 产品化与完整回归" : "Domain-benchmark expansion, Eval Dataset productization, and complete regression"}</p><div class="hero-meta"><span>${items.length} built-in cases</span><span>${liveEligibleCount} live cases</span><span>${benchmarkRows.length} benchmark methods</span></div></section>
<div class="verdict"><b>${zh ? "核心结论" : "Core verdict"}</b><p>${html(verdict(language))}</p></div><section class="stats"><article class="stat"><span>${zh ? "离线 Case" : "Offline cases"}</span><strong>${offline.summary.cases}/${offline.summary.cases}</strong><small>${offline.summary.checks.passed}/${offline.summary.checks.total} checks</small></article><article class="stat"><span>${zh ? "真实严格 Case" : "Live strict cases"}</span><strong>${strictCasePass}/${live.summary.cases}</strong><small>${ratio(strictCasePass, live.summary.cases)}</small></article><article class="stat"><span>Intent Judge</span><strong>${judgeSummary.intent_semantic_fit.pass}/${judgeSummary.intent_semantic_fit.total}</strong><small>${ratio(judgeSummary.intent_semantic_fit.pass, judgeSummary.intent_semantic_fit.total)}</small></article><article class="stat"><span>Answer Judge</span><strong>${judgeSummary.answer_task_success.pass}/${judgeSummary.answer_task_success.total}</strong><small>${ratio(judgeSummary.answer_task_success.pass, judgeSummary.answer_task_success.total)}</small></article><article class="stat"><span>E2E P95</span><strong>${formatMs(latency.p95)}</strong><small>max ${formatMs(latency.max)}</small></article></section>
<section class="section"><h2>${zh ? "0. 执行摘要" : "0. Executive summary"}</h2><p class="lead">${zh ? "确定性工程契约、真实 Agent 执行、语义 Judge 和性能分别报告，避免混合总分掩盖业务失败。" : "Deterministic contracts, live Agent execution, semantic judges, and performance are reported separately so a blended score cannot hide business failures."}</p><div class="grid2"><div class="finding"><b>${zh ? "覆盖扩展" : "Coverage expansion"}</b><p>${zh ? `${datasetRows.length} 个 Dataset、${items.length} 个 Case；${benchmarkInspiredCount} 个原创 Case 适配 ${benchmarkRows.length} 个公开方法，${liveEligibleCount} 个可真实执行。` : `${datasetRows.length} datasets and ${items.length} cases; ${benchmarkInspiredCount} original cases adapt ${benchmarkRows.length} public methods, and ${liveEligibleCount} permit live execution.`}</p></div><div class="finding"><b>${zh ? "离线基线" : "Offline baseline"}</b><p>${offlineGatePass ? `${offline.summary.cases}/${offline.summary.cases} · ${offline.summary.checks.passed}/${offline.summary.checks.total}` : "FAIL"}</p></div><div class="finding"><b>${zh ? "真实严格门禁" : "Live strict gate"}</b><p>${strictCasePass}/${live.summary.cases} · ${live.summary.checks.blockingFailures} blocking · ${live.summary.checks.errors} errors.</p></div><div class="finding"><b>${zh ? "Judge 边界" : "Judge boundary"}</b><p>${zh ? "Strict JSON Judge 尚未用双人审核 Golden 完成人工校准，因此只作诊断。" : "Strict-JSON judges remain diagnostic until calibrated against dual-reviewed Golden labels."}</p></div></div><div class="callout warning">${zh ? `Answer Judge 通过数比严格 Case 通过数高 ${strictSemanticGap} 条；路由与委派层有 ${categoryMetric("routing_contract").signals} 个非通过信号，资源预算层有 ${categoryMetric("runtime_budget").signals} 个。应先修路由契约与调用放大，再校准 Judge。${offlineOnlyDatasetIds.join("、")} 暂无真实运行覆盖。` : `Answer-judge passes exceed strict case passes by ${strictSemanticGap}. Routing and delegation contribute ${categoryMetric("routing_contract").signals} non-passing signals, while runtime budgets contribute ${categoryMetric("runtime_budget").signals}. Fix routing contracts and call amplification before promoting judges. ${offlineOnlyDatasetIds.join(", ")} currently lack live-run coverage.`}</div></section>
<section class="section"><h2>${zh ? "1. 与产品主链路一致的覆盖" : "1. Coverage aligned with the product path"}</h2><p class="lead">${zh ? `40 条新增 Case 显式标注工作流阶段；旧有 ${items.length - workflowTagged} 条需要补齐同一元数据。` : `The 40 new cases explicitly tag a workflow stage; the earlier ${items.length - workflowTagged} need the same metadata.`}</p><div class="flow">${workflowStages.map((stage, index) => `<div><b>0${index + 1}</b><strong>${html(stage[language])}</strong><small>${stage.count} ${zh ? "条显式标注" : "explicit tags"}</small></div>`).join("")}</div></section>
<section class="section page-break"><h2>${zh ? "2. Dataset 覆盖矩阵" : "2. Dataset coverage matrix"}</h2><table><thead><tr><th>Dataset</th><th>${zh ? "维度" : "Dimension"}</th><th>${zh ? "总量" : "Total"}</th><th>Live</th><th>${zh ? "重点" : "Purpose"}</th></tr></thead><tbody>${datasetTable}</tbody></table></section>
<section class="section"><h2>${zh ? "3. 分层结果" : "3. Layered result"}</h2><p class="lead">${zh ? "严格通过要求全部阻断契约通过；Judge 只评估语义，两层不能互相替代。" : "Strict pass requires every blocking contract to pass. Judges evaluate semantics only; the layers cannot substitute for one another."}</p><table><thead><tr><th>${zh ? "维度" : "Dimension"}</th><th>${zh ? "内置" : "Built-in"}</th><th>Live</th><th>${zh ? "严格通过" : "Strict pass"}</th><th>Intent</th><th>Answer</th><th>P50</th></tr></thead><tbody>${dimensionTable}</tbody></table><h3>${zh ? "按实际回答模型" : "By resolved answer model"}</h3><table><thead><tr><th>Model</th><th>Cases</th><th>${zh ? "严格通过" : "Strict pass"}</th><th>Answer</th><th>P50</th><th>P95</th></tr></thead><tbody>${modelTable}</tbody></table></section>
<section class="section"><h2>${zh ? "4. 失败与尾延迟下钻" : "4. Failure and tail-latency drill-down"}</h2><div class="callout ${failedChecks.length ? "danger" : ""}">${failedChecks.length ? (zh ? `${failedChecks.length} 个非通过信号分布在 ${signalAffectedCases} 个真实 Case；其中 ${failedCases.length} 个未满足严格门禁。` : `${failedChecks.length} non-passing signals occur across ${signalAffectedCases} live cases; ${failedCases.length} fail the strict gate.`) : (zh ? "真实运行没有非通过信号。" : "The live run has no non-passing signals.")}</div><table><thead><tr><th>${zh ? "失败层" : "Failure layer"}</th><th>Cases</th><th>Signals</th><th>Blocking</th><th>Errors</th></tr></thead><tbody>${failureTable}</tbody></table><h3>${zh ? "高频具体信号" : "Top individual signals"}</h3><table><thead><tr><th>Evaluator</th><th>Cases</th><th>Signals</th><th>Blocking</th></tr></thead><tbody>${signalTable}</tbody></table><h3>${zh ? "Judge 一致性复核候选" : "Judge consistency review candidates"}</h3><table><thead><tr><th>Case</th><th>Judge</th><th>Score</th><th>${zh ? "理由摘要" : "Rationale"}</th></tr></thead><tbody>${judgeConsistencyTable}</tbody></table><h3>${zh ? "最慢的 10 个 Case" : "Ten slowest cases"}</h3><table><thead><tr><th>#</th><th>Case</th><th>Model</th><th>Agent</th><th>E2E</th><th>Status</th></tr></thead><tbody>${slowTable}</tbody></table><div class="callout warning">P50 ${formatMs(latency.p50)} · P90 ${formatMs(latency.p90)} · P95 ${formatMs(latency.p95)} · Max ${formatMs(latency.max)}. ${zh ? "性能结论需至少三次重复运行确认。" : "Performance conclusions require at least three repeated runs."}</div></section>
<section class="section page-break"><h2>${zh ? "5. Eval 工程判断与行动" : "5. Eval-engineering judgment and actions"}</h2><ol>${actions.map(item => `<li>${html(item)}</li>`).join("")}</ol></section><section class="section"><h2>${zh ? "6. Benchmark 方法来源与边界" : "6. Benchmark sources and boundaries"}</h2><p class="lead">${zh ? "只复用公开 Benchmark 的能力定义、任务形态和评分思想；项目题目、上下文与期望答案均为原创，结果不是官方 Benchmark 分数。" : "Only public capability definitions, task shapes, and scoring ideas are reused. Project cases are original, so these are not official benchmark scores."}</p><table><thead><tr><th>Benchmark</th><th>Cases</th></tr></thead><tbody>${sourceTable}</tbody></table></section><section class="section"><h2>${zh ? "7. 证据与复现" : "7. Evidence and reproduction"}</h2><p class="mono">Offline: ${html(offline.runId)}<br>Live: ${html(live.runId)}<br>Dataset: ${html(offline.dataset.fingerprint)}<br>Config: ${html(offline.configuration.effectiveFingerprint)}</p><p><a href="https://langfuse.com/academy/datasets">Langfuse Datasets</a> · <a href="https://langfuse.com/academy/evaluate/choosing-what-to-evaluate">Choosing what to evaluate</a> · <a href="https://langfuse.com/academy/evaluate/writing-evaluators">Writing evaluators</a></p><p class="mono">${html(offlinePath)}<br>${html(livePath)}</p></section></main></body></html>`;
}

mkdirSync(assetsRoot, { recursive: true });
const reportFontAssets = resolve(projectRoot, "assets/fonts");
for (const [source, target] of [
  ["GeneralSans-Regular.woff2", "GeneralSans-Regular.woff2"],
  ["GeneralSans-Semibold.woff2", "GeneralSans-Semibold.woff2"],
  ["Gelasio-Medium.ttf", "Gelasio-Medium.ttf"]
]) copyFileSync(join(reportFontAssets, source), join(assetsRoot, target));

const outputs = {};
for (const language of ["zh", "en"]) {
  const suffix = language === "zh" ? "zh-CN" : "en";
  const base = join(outputRoot, `personal-copilot-domain-benchmark-eval-report.${suffix}`);
  const markdownPath = `${base}.md`;
  const htmlPath = `${base}.html`;
  const pdfPath = `${base}.pdf`;
  writeFileSync(markdownPath, markdown(language), "utf8");
  writeFileSync(htmlPath, htmlReport(language), "utf8");
  execFileSync("weasyprint", [htmlPath, pdfPath], { stdio: "inherit" });
  outputs[suffix] = { markdown: markdownPath, html: htmlPath, pdf: pdfPath };
}
const manifestPath = join(outputRoot, "report-manifest.json");
writeFileSync(manifestPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), sourceRuns: { offline: offlinePath, live: livePath }, coverage: { datasets: datasetRows.length, cases: items.length, liveEligible: liveEligibleCount, benchmarkInspired: benchmarkInspiredCount, benchmarkFamilies: benchmarkRows.length, workflowTagged, offlineOnlyDatasets: offlineOnlyDatasetIds }, results: { offlineGatePass, strictGatePass, strictCasePass, strictSemanticGap, signalAffectedCases, executionErrorCases, judgeConsistencyCandidates: judgeConsistencyCandidates.map(item => ({ scopeId: item.scopeId, evaluator: item.evaluator, score: item.score, reason: item.reason })), offlineChecks: offline.summary.checks, liveChecks: live.summary.checks, judges: judgeSummary, failureCategories: failureCategoryRows, latency }, outputs }, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputRoot, manifestPath, outputs }, null, 2)}\n`);
