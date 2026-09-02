import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { config, appRoot } from "./config.mjs";
import { evalDatasetCatalog } from "./eval-dataset-catalog.mjs";
import {
  appendEvalRunLog,
  cancelEvalRunRecord,
  completeEvalRunRecord,
  createEvalRunRecord,
  evalRunRecord,
  failEvalRunRecord,
  failInterruptedEvalRuns,
  listEvalRunRecords,
  queueEvalRunRecord,
  startEvalRunRecord,
  updateEvalRunLifecycleRecord
} from "./eval-run-store.mjs";
import { AppError } from "./errors.mjs";
import { listGoldenSetItems } from "./golden-set-store.mjs";
import { loadEvalConfiguration } from "./evals/lib/eval-config.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const LIVE_PROFILES = new Set(["live", "live-traced", "live-judged"]);
const profileDescriptions = Object.freeze({
  local: "Fast offline deterministic checks for development; no external calls.",
  ci: "Full offline release gate; rejects new diagnostic debt against the accepted baseline.",
  live: "Runs live-eligible cases against real models and tools without Trace export or an LLM judge.",
  "live-traced": "Runs live-eligible cases and exports Langfuse traces; no LLM judge.",
  "live-judged": "Runs live-eligible cases with Langfuse tracing and LLM-as-a-Judge scoring."
});
const profileNames = Object.freeze({ local: "Local", ci: "CI", live: "Live", "live-traced": "Live Traced", "live-judged": "Live Judged" });

function title(value) {
  return String(value || "").split("-").map(word => word ? word[0].toUpperCase() + word.slice(1) : word).join(" ");
}

function safeName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 120) {
    throw new AppError("Eval Run 名称长度必须为 1 到 120 个字符", { code: "invalid_eval_run_name", status: 400, expose: true });
  }
  return name;
}

function cleanLog(value) {
  return String(value || "")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9._-]{8,}\b/gu, "[REDACTED_KEY]")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/giu, "$1[REDACTED]");
}

function resultProjection(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  return {
    schemaVersion: "copilot-eval-run-result.v1",
    mode: report?.mode || null,
    configuration: report?.configuration || {},
    dataset: report?.dataset || {},
    judgePolicy: report?.judgePolicy || { enabled: false },
    modelPolicy: report?.modelPolicy || {},
    failed_cases: cases.filter(item => item.status !== "pass").slice(0, 200),
    failed_checks: checks.filter(item => item.status !== "pass").slice(0, 500).map(item => ({
      scopeId: item.scopeId,
      evaluator: item.evaluator,
      evaluatorVersion: item.evaluatorVersion,
      severity: item.severity,
      status: item.status,
      score: item.score,
      reason: item.reason,
      evidence: item.evidence
    }))
  };
}

function cleanGoldenItem(item) {
  const copy = structuredClone(item);
  for (const key of ["golden_id", "candidate_id", "item_version", "active", "lifecycle_status", "updated_at", "dataset_id", "read_only"]) delete copy[key];
  return copy;
}

export function createEvalRunService({
  spawnProcess = spawn,
  runDirectory = resolve(dirname(config.database.path), "eval-runs"),
  recoverInterrupted = true
} = {}) {
  const active = new Map();
  let shuttingDown = false;
  const baseConfiguration = loadEvalConfiguration({ profileName: "local" });
  const profileConfigurations = new Map(baseConfiguration.availableProfiles.map(profile => [
    profile,
    loadEvalConfiguration({ profileName: profile })
  ]));
  if (recoverInterrupted) failInterruptedEvalRuns();

  function configurationForUser(userId) {
    const catalog = evalDatasetCatalog({ userId });
    const datasets = catalog.datasets.map(dataset => ({
      id: dataset.id,
      name: dataset.name,
      version: dataset.version,
      source: dataset.source,
      dimension: dataset.evaluation_dimension,
      purpose: dataset.purpose,
      item_count: dataset.active_count,
      live_eligible_count: dataset.live_eligible_count,
      available: dataset.source !== "user-feedback" || dataset.active_count > 0
    }));
    const profiles = [...profileConfigurations].map(([id, configuration]) => ({
      id,
      name: profileNames[id] || title(id),
      description: profileDescriptions[id] || "Configured evaluation profile",
      mode: configuration.run.execution.mode,
      traces: configuration.run.execution.traceLive,
      judge: configuration.run.judge.enabled,
      judge_model: configuration.run.judge.enabled ? configuration.run.judge.model : null,
      minimum_cases: configuration.run.gate.minimumCases,
      requires_confirmation: LIVE_PROFILES.has(id)
    }));
    return { profiles, datasets };
  }

  function validateDefinition({ userId, profile, datasetIds }) {
    const configuration = profileConfigurations.get(String(profile || ""));
    if (!configuration) {
      throw new AppError("Eval Profile 不存在", { code: "invalid_eval_run_profile", status: 400, expose: true });
    }
    if (!Array.isArray(datasetIds) || !datasetIds.length || datasetIds.length > 50) {
      throw new AppError("至少选择一个 Eval Dataset", { code: "invalid_eval_run_datasets", status: 400, expose: true });
    }
    const uniqueIds = [...new Set(datasetIds.map(value => String(value || "").trim()).filter(Boolean))];
    const catalog = configurationForUser(userId);
    const byId = new Map(catalog.datasets.map(dataset => [dataset.id, dataset]));
    const unknown = uniqueIds.filter(id => !byId.has(id));
    if (unknown.length) {
      throw new AppError("Eval Run 引用了未知 Dataset", { code: "invalid_eval_run_datasets", status: 400, expose: true });
    }
    const unavailable = uniqueIds.filter(id => !byId.get(id).available);
    if (unavailable.length) {
      throw new AppError("所选 Dataset 没有有效数据项", { code: "eval_run_dataset_empty", status: 409, expose: true });
    }
    const live = configuration.run.execution.mode === "live";
    const cases = uniqueIds.reduce((sum, id) => sum + Number(live ? byId.get(id).live_eligible_count : byId.get(id).item_count), 0);
    if (cases < configuration.run.gate.minimumCases) {
      throw new AppError("所选 Dataset 不满足当前 Profile 的最小 Case 数", { code: "eval_run_minimum_cases", status: 409, expose: true });
    }
    return { configuration, datasetIds: uniqueIds, expectedCases: cases };
  }

  function runPaths(userId, runId) {
    const owner = crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 24);
    const directory = join(runDirectory, owner);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return {
      report: join(directory, `${runId}.json`),
      feedback: join(directory, `${runId}-feedback-golden.jsonl`)
    };
  }

  function runnerArguments({ run, configuration, paths }) {
    const args = [resolve(appRoot, "evals/run.mjs"), "--profile", run.profile, "--output", paths.report, "--label", run.id];
    for (const datasetId of run.dataset_ids.filter(id => id !== "feedback-golden")) args.push("--dataset-id", datasetId);
    if (run.dataset_ids.includes("feedback-golden")) args.push("--dataset", paths.feedback);
    if (configuration.run.execution.mode === "live") args.push("--confirm-live");
    return args;
  }

  function writeFeedbackSnapshot({ userId, run, paths }) {
    if (!run.dataset_ids.includes("feedback-golden")) return;
    const items = listGoldenSetItems({ userId, status: "active", limit: 2000 }).map(cleanGoldenItem);
    if (!items.length) {
      throw new AppError("Feedback Golden Set 没有有效数据项", { code: "eval_run_dataset_empty", status: 409, expose: true });
    }
    writeFileSync(paths.feedback, `${items.map(item => JSON.stringify(item)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }

  function finishProcess({ userId, runId, code, cancelRequested }) {
    active.delete(runId);
    if (shuttingDown) return;
    if (cancelRequested()) {
      const current = evalRunRecord({ userId, runId });
      if (current.execution_status !== "cancelled") cancelEvalRunRecord({ userId, runId });
      return;
    }
    const current = evalRunRecord({ userId, runId });
    const reportPath = runPaths(userId, runId).report;
    if ((code === 0 || code === 1) && existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        const gateStatus = Number(report.summary?.checks?.blockingFailures || 0) > 0 ? "failed" : "passed";
        completeEvalRunRecord({
          userId,
          runId,
          gateStatus,
          reportRunId: report.runId,
          summary: report.summary || {},
          result: resultProjection(report)
        });
        return;
      } catch (error) {
        failEvalRunRecord({ userId, runId, errorMessage: `Could not read evaluation report: ${error.message}` });
        return;
      }
    }
    failEvalRunRecord({
      userId,
      runId,
      errorMessage: current.error_message || `Evaluation process exited with code ${code ?? "unknown"}.`
    });
  }

  function start({ userId, runId, confirmLive = false }) {
    if (shuttingDown) throw new AppError("Eval Runner 正在关闭", { code: "eval_runner_unavailable", status: 503, expose: true });
    const run = evalRunRecord({ userId, runId });
    const { configuration } = validateDefinition({ userId, profile: run.profile, datasetIds: run.dataset_ids });
    if (configuration.run.execution.mode === "live" && confirmLive !== true) {
      throw new AppError("真实 Eval 需要明确确认额度消耗", { code: "eval_run_live_confirmation_required", status: 409, expose: true });
    }
    const paths = runPaths(userId, runId);
    writeFeedbackSnapshot({ userId, run, paths });
    queueEvalRunRecord({ userId, runId, reportPath: paths.report });
    let child;
    try {
      child = spawnProcess(process.execPath, runnerArguments({ run, configuration, paths }), {
        cwd: appRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      failEvalRunRecord({ userId, runId, errorMessage: error.message });
      throw new AppError("Eval Runner 无法启动", { code: "eval_runner_start_failed", status: 503, expose: true, cause: error });
    }
    let cancelled = false;
    active.set(runId, { child, userId, cancel: () => { cancelled = true; } });
    startEvalRunRecord({ userId, runId });
    appendEvalRunLog({ userId, runId, text: `[${new Date().toISOString()}] Evaluation started with profile ${run.profile}.\n` });
    child.stdout?.on("data", chunk => appendEvalRunLog({ userId, runId, text: cleanLog(chunk) }));
    child.stderr?.on("data", chunk => appendEvalRunLog({ userId, runId, text: cleanLog(chunk) }));
    child.once("error", error => {
      active.delete(runId);
      failEvalRunRecord({ userId, runId, errorMessage: error.message });
    });
    child.once("close", code => finishProcess({ userId, runId, code, cancelRequested: () => cancelled }));
    return evalRunRecord({ userId, runId });
  }

  function create({ userId, body = {}, parentRunId = null }) {
    const name = safeName(body.name);
    const validated = validateDefinition({ userId, profile: body.profile || "local", datasetIds: body.datasetIds });
    const run = createEvalRunRecord({
      userId,
      name,
      profile: body.profile || "local",
      datasetIds: validated.datasetIds,
      parentRunId
    });
    return body.start === true ? start({ userId, runId: run.id, confirmLive: body.confirmLive === true }) : run;
  }

  function rerun({ userId, runId, confirmLive = false }) {
    const source = evalRunRecord({ userId, runId });
    if (!TERMINAL_STATUSES.has(source.execution_status)) {
      throw new AppError("只有已结束的 Eval Run 可以重跑", { code: "eval_run_not_rerunnable", status: 409, expose: true });
    }
    return create({
      userId,
      body: {
        name: `${source.name} · rerun`,
        profile: source.profile,
        datasetIds: source.dataset_ids,
        start: true,
        confirmLive
      },
      parentRunId: source.id
    });
  }

  function cancel({ userId, runId }) {
    const execution = active.get(runId);
    const run = cancelEvalRunRecord({ userId, runId });
    if (execution && execution.userId === String(userId)) {
      execution.cancel();
      execution.child.kill("SIGTERM");
    }
    return run;
  }

  function action({ userId, runId, action: requestedAction, confirmLive = false }) {
    if (requestedAction === "start") return start({ userId, runId, confirmLive });
    if (requestedAction === "cancel") return cancel({ userId, runId });
    if (requestedAction === "rerun") return rerun({ userId, runId, confirmLive });
    if (["archive", "restore"].includes(requestedAction)) {
      return updateEvalRunLifecycleRecord({ userId, runId, action: requestedAction });
    }
    throw new AppError("无效的 Eval Run 操作", { code: "invalid_eval_run_action", status: 400, expose: true });
  }

  function list({ userId, lifecycle = "active" }) {
    const runs = listEvalRunRecords({ userId, lifecycle });
    const configuration = configurationForUser(userId);
    return {
      schemaVersion: "copilot-eval-runs.v1",
      runs,
      summary: {
        total: runs.length,
        drafts: runs.filter(run => run.execution_status === "draft").length,
        active: runs.filter(run => ["queued", "running"].includes(run.execution_status)).length,
        passed: runs.filter(run => run.execution_status === "completed" && run.gate_status === "passed").length,
        attention: runs.filter(run => run.execution_status === "failed" || run.gate_status === "failed").length
      },
      configuration
    };
  }

  function shutdown() {
    shuttingDown = true;
    for (const [runId, execution] of active) {
      execution.cancel();
      try {
        cancelEvalRunRecord({ userId: execution.userId, runId });
      } catch {
        // 关闭路径尽力而为；终态或已丢失的 Run 不阻塞服务退出。
      }
      execution.child.kill("SIGTERM");
    }
    active.clear();
  }

  return {
    list,
    get: ({ userId, runId }) => evalRunRecord({ userId, runId }),
    create,
    action,
    shutdown
  };
}

export const evalRunService = createEvalRunService();
