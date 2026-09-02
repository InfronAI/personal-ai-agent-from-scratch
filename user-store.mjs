import crypto from "node:crypto";

import { database } from "./database.mjs";
import { AppError } from "./errors.mjs";

const userByNormalizedName = database.prepare(`
  SELECT id, username, normalized_username, active, created_at, updated_at, last_login_at
  FROM local_users WHERE normalized_username = ? LIMIT 1
`);
const userById = database.prepare(`
  SELECT id, username, normalized_username, active, created_at, updated_at, last_login_at
  FROM local_users WHERE id = ? LIMIT 1
`);
const insertUser = database.prepare(`
  INSERT INTO local_users (
    id, username, normalized_username, active, created_at, updated_at, last_login_at
  ) VALUES (?, ?, ?, 1, ?, ?, ?)
`);
const touchUser = database.prepare(`
  UPDATE local_users SET updated_at = ?, last_login_at = ?
  WHERE id = ? AND active = 1
`);

function publicUser(row) {
  if (!row || !row.active) return null;
  return {
    user_id: row.id,
    username: row.username,
    normalized_username: row.normalized_username,
    created_at: row.created_at,
    last_login_at: row.last_login_at
  };
}

export function normalizeUsername(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("und");
}

function validatedUsername(value) {
  const username = String(value || "").normalize("NFC").trim();
  const normalized = normalizeUsername(username);
  const characters = [...normalized];
  if (
    characters.length < 2
    || characters.length > 32
    || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(normalized)
  ) {
    throw new AppError("用户名需为 2–32 个字母、数字、点、下划线或连字符，且必须以字母或数字开头", {
      code: "invalid_username",
      status: 400,
      expose: true
    });
  }
  return { username, normalized };
}

export const loginWithUsername = database.transaction(value => {
  const { username, normalized } = validatedUsername(value);
  const now = new Date().toISOString();
  const existing = userByNormalizedName.get(normalized);
  if (existing) {
    if (!existing.active) {
      throw new AppError("该本地用户已停用", { code: "user_disabled", status: 403, expose: true });
    }
    touchUser.run(now, now, existing.id);
    return publicUser({ ...existing, updated_at: now, last_login_at: now });
  }
  const id = `usr_${crypto.randomBytes(16).toString("hex")}`;
  insertUser.run(id, username, normalized, now, now, now);
  return publicUser(userById.get(id));
});

export function findUserById(userId) {
  return publicUser(userById.get(String(userId || "")));
}

export function userStoreStatus() {
  return {
    configured: true,
    provider: "sqlite",
    authentication: "local-username",
    passwordless_mvp: true
  };
}
