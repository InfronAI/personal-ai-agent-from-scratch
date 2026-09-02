import crypto from "node:crypto";

import { config } from "./config.mjs";
import { AppError } from "./errors.mjs";

function cookies(header) {
  return Object.fromEntries(String(header || "").split(";").map(item => item.trim()).filter(Boolean).map(item => {
    const index = item.indexOf("=");
    return index < 0 ? [item, ""] : [item.slice(0, index), item.slice(index + 1)];
  }));
}

function signature(payload) {
  return crypto.createHmac("sha256", config.auth.sessionSecret).update(payload).digest("base64url");
}

function signedIdentity(userId) {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    userId,
    expiresAt: Date.now() + (config.auth.cookieTtlSeconds * 1000)
  })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

function verifyIdentity(value) {
  const [payload, supplied] = String(value || "").split(".");
  if (!payload || !supplied) return null;
  const expected = signature(payload);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return decoded.version === 1
      && decoded.expiresAt > Date.now()
      && /^usr_[a-f0-9]{32}$/.test(decoded.userId)
      ? decoded.userId
      : null;
  } catch {
    return null;
  }
}

function pseudonym(subject, tenant = "default") {
  return `usr_${crypto.createHmac("sha256", config.auth.sessionSecret).update(`${tenant}\0${subject}`).digest("hex").slice(0, 32)}`;
}

export function resolveIdentity(request, response) {
  if (config.auth.mode === "trusted-header") {
    const subject = String(request.headers[config.auth.trustedUserHeader] || "").trim();
    const tenant = String(request.headers[config.auth.trustedTenantHeader] || "default").trim();
    if (!subject) throw new AppError("Authentication is required", { code: "unauthorized", status: 401, expose: true });
    return { userId: pseudonym(subject, tenant), tenantId: tenant, username: subject, mode: "trusted-header" };
  }

  const existing = verifyIdentity(cookies(request.headers.cookie)[config.auth.cookieName]);
  if (!existing) {
    throw new AppError("请先登录 Personal Copilot", { code: "unauthorized", status: 401, expose: true });
  }
  return { userId: existing, tenantId: "local", mode: "local-username" };
}

export function optionalIdentity(request, response) {
  try {
    return resolveIdentity(request, response);
  } catch (error) {
    if (error?.code === "unauthorized") return null;
    throw error;
  }
}

export function issueIdentityCookie(response, { userId }) {
  if (!/^usr_[a-f0-9]{32}$/.test(String(userId || ""))) {
    throw new AppError("无法为无效用户签发登录状态", { code: "invalid_identity", status: 500 });
  }
  const secure = config.environment === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${config.auth.cookieName}=${signedIdentity(userId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.auth.cookieTtlSeconds}${secure}`
  );
}

export function clearIdentityCookie(response) {
  const secure = config.environment === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${config.auth.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  );
}

export function validateOrigin(request) {
  const origin = String(request.headers.origin || "");
  if (!origin) return;
  const hostOrigin = `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
  if (origin !== hostOrigin && !config.http.allowedOrigins.includes(origin)) {
    throw new AppError("Origin is not allowed", { code: "forbidden_origin", status: 403, expose: true });
  }
}
