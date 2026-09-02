import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-user-store-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "users.sqlite");
process.env.COPILOT_SESSION_SECRET = "copilot-user-store-test-secret-000000000000000000";

const { closeDatabase } = await import("../database.mjs");
const { findUserById, loginWithUsername, normalizeUsername } = await import(`../user-store.mjs?test=${Date.now()}`);

after(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("用户名经过 Unicode 归一化并映射到稳定的本地用户空间", () => {
  assert.equal(normalizeUsername("  Ａlice  "), "alice");
  const first = loginWithUsername("Ａlice");
  const second = loginWithUsername("alice");
  assert.equal(first.user_id, second.user_id);
  assert.equal(first.username, "Ａlice");
  assert.equal(findUserById(first.user_id).normalized_username, "alice");
});

test("用户名协议拒绝空值、空格和不可控标点", () => {
  for (const invalid of ["", "a", "two words", "../alice", "alice@corp"]) {
    assert.throws(() => loginWithUsername(invalid), error => error.code === "invalid_username");
  }
  assert.equal(loginWithUsername("安德鲁_01").normalized_username, "安德鲁_01");
});
