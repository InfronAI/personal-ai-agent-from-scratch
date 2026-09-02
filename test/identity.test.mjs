import assert from "node:assert/strict";
import test from "node:test";

const {
  clearIdentityCookie,
  issueIdentityCookie,
  resolveIdentity,
  validateOrigin
} = await import("../identity.mjs");

function responseStub() {
  const headers = new Map();
  return { headers, setHeader: (name, value) => headers.set(name.toLowerCase(), value) };
}

test("本地身份必须先登录，签名 Cookie 只接受服务端签发的用户", () => {
  assert.throws(
    () => resolveIdentity({ headers: {} }, responseStub()),
    error => error.code === "unauthorized"
  );

  const firstResponse = responseStub();
  issueIdentityCookie(firstResponse, { userId: "usr_0123456789abcdef0123456789abcdef" });
  const cookie = firstResponse.headers.get("set-cookie").split(";")[0];
  const secondResponse = responseStub();
  const second = resolveIdentity({ headers: { cookie } }, secondResponse);
  assert.equal(second.userId, "usr_0123456789abcdef0123456789abcdef");
  assert.equal(secondResponse.headers.has("set-cookie"), false);

  const [cookieName, cookieValue] = cookie.split("=");
  const forged = `${cookieName}=${cookieValue.slice(0, -1)}${cookieValue.endsWith("a") ? "b" : "a"}`;
  assert.throws(
    () => resolveIdentity({ headers: { cookie: forged } }, responseStub()),
    error => error.code === "unauthorized"
  );

  const logoutResponse = responseStub();
  clearIdentityCookie(logoutResponse);
  assert.match(logoutResponse.headers.get("set-cookie"), /Max-Age=0/u);
});

test("跨源状态变更请求会被拒绝", () => {
  assert.throws(
    () => validateOrigin({ headers: { origin: "https://attacker.example", host: "copilot.example" }, socket: { encrypted: true } }),
    error => error.code === "forbidden_origin"
  );
});
