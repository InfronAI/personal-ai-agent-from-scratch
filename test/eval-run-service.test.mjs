import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-eval-run-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "copilot.sqlite");
process.env.COPILOT_SESSION_SECRET = "copilot-eval-run-test-session-secret-0000000000000000";
process.env.LANGFUSE_PUBLIC_KEY = "";
process.env.LANGFUSE_SECRET_KEY = "";

const { createEvalRunService } = await import(`../eval-run-service.mjs?test=${Date.now()}`);
const { closeDatabase } = await import("../database.mjs");

let autoComplete = true;
const children = [];

function fakeSpawn(_executable, argumentsList) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit("close", null);
    return true;
  };
  children.push({ child, argumentsList });
  if (autoComplete) {
    setImmediate(() => {
      const output = argumentsList[argumentsList.indexOf("--output") + 1];
      writeFileSync(output, JSON.stringify({
        schemaVersion: "copilot-eval-result.v1",
        runId: "offline-fake-report",
        mode: "offline-scripted",
        configuration: { profile: "local", datasetIds: ["core"] },
        dataset: { items: 19, fingerprint: "a".repeat(64) },
        summary: {
          cases: 19,
          checks: { total: 42, passed: 42, failed: 0, errors: 0, blockingFailures: 0, diagnosticFailures: 0 },
          bySuite: { core: { cases: 19, blockingFailures: 0, diagnosticFailures: 0 } }
        },
        cases: [{ id: "core-case", status: "pass" }],
        checks: [{ scopeId: "core-case", evaluator: "contract", severity: "blocking", status: "pass", score: 1 }]
      }));
      child.stderr.write("authorization: Bearer sk-test-secret-value\n");
      child.stderr.end();
      child.emit("close", 0);
    });
  }
  return child;
}

const service = createEvalRunService({
  spawnProcess: fakeSpawn,
  runDirectory: join(directory, "runs"),
  recoverInterrupted: false
});

after(() => {
  service.shutdown();
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

async function waitForStatus(userId, runId, expected) {
  for (let index = 0; index < 50; index += 1) {
    const run = service.get({ userId, runId });
    if (run.execution_status === expected) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Eval Run ${runId} did not reach ${expected}`);
}

test("Eval Run 在用户空间内完成 Draft、执行、结果、归档与重跑生命周期", async () => {
  const userId = "usr_eval_run_owner";
  const profiles = service.list({ userId }).configuration.profiles;
  assert.deepEqual(profiles.map(profile => profile.name), ["Local", "CI", "Live", "Live Traced", "Live Judged"]);
  assert.match(profiles.find(profile => profile.id === "ci").description, /diagnostic debt/u);
  assert.equal(profiles.find(profile => profile.id === "live-judged").judge, true);
  assert.ok(profiles.find(profile => profile.id === "live-judged").judge_model);
  const draft = service.create({
    userId,
    body: { name: "Core regression", profile: "local", datasetIds: ["core"] }
  });
  assert.equal(draft.execution_status, "draft");
  assert.deepEqual(draft.dataset_ids, ["core"]);

  const running = service.action({ userId, runId: draft.id, action: "start" });
  assert.equal(running.execution_status, "running");
  const completed = await waitForStatus(userId, draft.id, "completed");
  assert.equal(completed.gate_status, "passed");
  assert.equal(completed.summary.cases, 19);
  assert.equal(completed.result.failed_checks.length, 0);
  assert.doesNotMatch(completed.log, /sk-test-secret-value/u);
  assert.match(completed.log, /\[REDACTED\]/u);
  assert.ok(children[0].argumentsList.includes("--dataset-id"));
  assert.ok(children[0].argumentsList.includes("core"));

  const archived = service.action({ userId, runId: draft.id, action: "archive" });
  assert.equal(archived.lifecycle_status, "archived");
  assert.equal(service.list({ userId, lifecycle: "active" }).runs.length, 0);
  const restored = service.action({ userId, runId: draft.id, action: "restore" });
  assert.equal(restored.lifecycle_status, "active");

  const rerun = service.action({ userId, runId: draft.id, action: "rerun" });
  assert.equal(rerun.parent_run_id, draft.id);
  assert.equal((await waitForStatus(userId, rerun.id, "completed")).gate_status, "passed");

  assert.throws(
    () => service.get({ userId: "usr_other", runId: draft.id }),
    error => error.code === "eval_run_not_found"
  );

  const unrelated = service.create({
    userId,
    body: { name: "Unrelated run", profile: "local", datasetIds: ["core"], parentRunId: draft.id }
  });
  assert.equal(unrelated.parent_run_id, null);
});

test("Live Eval 必须确认额度消耗，运行中的任务可以取消", async () => {
  const userId = "usr_eval_run_live";
  const liveDraft = service.create({
    userId,
    body: { name: "Live smoke", profile: "live", datasetIds: ["core"] }
  });
  assert.throws(
    () => service.action({ userId, runId: liveDraft.id, action: "start" }),
    error => error.code === "eval_run_live_confirmation_required"
  );

  autoComplete = false;
  const running = service.action({ userId, runId: liveDraft.id, action: "start", confirmLive: true });
  assert.equal(running.execution_status, "running");
  const cancelled = service.action({ userId, runId: liveDraft.id, action: "cancel" });
  assert.equal(cancelled.execution_status, "cancelled");
  assert.equal((await waitForStatus(userId, liveDraft.id, "cancelled")).gate_status, "pending");
  autoComplete = true;
});

test("Runner 同步启动失败会进入可诊断终态", () => {
  const failingService = createEvalRunService({
    spawnProcess: () => { throw new Error("spawn unavailable"); },
    runDirectory: join(directory, "failed-runs"),
    recoverInterrupted: false
  });
  const draft = failingService.create({
    userId: "usr_eval_spawn_failure",
    body: { name: "Spawn failure", profile: "local", datasetIds: ["core"] }
  });
  assert.throws(
    () => failingService.action({ userId: "usr_eval_spawn_failure", runId: draft.id, action: "start" }),
    error => error.code === "eval_runner_start_failed"
  );
  assert.equal(failingService.get({ userId: "usr_eval_spawn_failure", runId: draft.id }).execution_status, "failed");
  failingService.shutdown();
});
