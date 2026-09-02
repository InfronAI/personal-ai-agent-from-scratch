import crypto from "node:crypto";

import { config } from "./config.mjs";

export const MEMORY_POLICY_VERSION = "copilot-memory-policy.v3";

const SENSITIVE_PATTERNS = Object.freeze([
  /\bsk-lf-[A-Za-z0-9-]{12,}\b/u,
  /\b(?:or-|sk-)[A-Za-z0-9_-]{16,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*\b/iu,
  /\b(?:password|passwd|secret|api[ _-]?key|access[ _-]?token)\s*[:=：]\s*\S+/iu,
  /(?:密码|密钥|令牌|访问凭证)\s*[:=：]\s*\S+/u,
  /\b(?:\d[ -]*?){13,19}\b/u,
  /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/u
]);

const FORGET_PATTERN = /^(?:请|麻烦)?\s*(?:忘记|删除|清除|移除)(?:掉|关于)?\s*(?:我(?:的)?|这条|这段)?\s*(?:记忆|memory)?\s*[:：]?[\s]*(.+)$/iu;
const EXPLICIT_PATTERN = /^(?:请)?\s*(?:记住|记得|保存到记忆|remember|keep (?:this|that) in mind)\s*[:：]?[\s]*(.+)$/iu;
const QUESTION_PATTERN = /[?？]|(?:吗|呢|么)\s*$|(?:我(?:是|叫)什么|我的(?:名字|职业|角色)(?:是|叫)?什么|你(?:知道|记得|了解).*(?:我|名字|职业|角色))|\b(?:what(?:'s| is) my name|who am i|do (?:you|u) know me)\b|^(?:什么|为何|为什么|是否|how|what|why|which|when|where|who|do|did|can|could|would)\b/iu;

const TYPE_RULES = Object.freeze([
  {
    kind: "preference",
    reason: "stable_user_preference",
    pattern: /(?:我(?:更)?(?:喜欢|偏好|不喜欢)|我的偏好|i (?:prefer|like|dislike)|my preference)/iu,
    importance: 0.8
  },
  {
    kind: "profile",
    reason: "stable_user_profile",
    pattern: /(?:我叫(?!什么|啥|谁)|我的名字(?:是|叫)|我是(?:一名|一个)?(?!什么|谁)|我住在|我的职业(?:是|为)|我的角色(?:是|为)|my name is|i am (?:a|an)|i live in|my role is|my job is)/iu,
    importance: 0.75
  },
  {
    kind: "constraint",
    reason: "reusable_user_constraint",
    pattern: /(?:以后|始终|总是|默认|不要再|务必|always|from now on|never|by default)/iu,
    importance: 0.9
  }
]);

export function normalizeMemoryText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function containsSensitiveMemory(value) {
  const text = normalizeMemoryText(value);
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(text));
}

export function isMemoryQuestion(value) {
  return QUESTION_PATTERN.test(normalizeMemoryText(value));
}

function memorySubject(kind, content) {
  const value = normalizeMemoryText(content).toLocaleLowerCase("und");
  if (/(?:回答|回复|response|answer).*(?:中文|英文|语言|language)|(?:中文|英文|语言|language).*(?:回答|回复|response|answer)/iu.test(value)) {
    return "response-language";
  }
  if (/(?:回答|回复|response|answer).*(?:简洁|详细|长度|格式|风格|concise|detailed|format|style)/iu.test(value)) {
    return "response-style";
  }
  if (/(?:我叫(?!什么|啥|谁)|我的名字(?:是|叫)|my name is)/iu.test(value)) return "identity-name";
  if (/(?:我住在|i live in)/iu.test(value)) return "identity-location";
  if (/(?:我的职业|我的角色|my role is|my job is|i am a|i am an)/iu.test(value)) return "identity-occupation";
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `content-${digest}`;
}

function retentionDays(kind) {
  return kind === "profile"
    ? config.database.memoryProfileRetentionDays
    : config.database.memoryRetentionDays;
}

function skip(reason) {
  return Object.freeze({
    action: "skip",
    shouldWrite: false,
    kind: null,
    content: null,
    memoryKey: null,
    reason,
    policyVersion: MEMORY_POLICY_VERSION
  });
}

export function memoryWriteDecision(userMessage) {
  const value = normalizeMemoryText(userMessage);
  if (!value) return skip("empty_input");

  const forget = value.match(FORGET_PATTERN);
  if (forget?.[1]) {
    return Object.freeze({
      action: "forget",
      shouldWrite: false,
      kind: null,
      content: null,
      memoryKey: null,
      query: normalizeMemoryText(forget[1]),
      reason: "explicit_forget_request",
      policyVersion: MEMORY_POLICY_VERSION
    });
  }

  if (containsSensitiveMemory(value)) return skip("sensitive_content");

  const explicit = value.match(EXPLICIT_PATTERN);
  const candidate = normalizeMemoryText(explicit?.[1] || value);
  if (isMemoryQuestion(candidate)) return skip("question_not_memory");
  const matched = TYPE_RULES.find(rule => rule.pattern.test(candidate));
  if (!explicit && !matched) return skip("transient_turn");

  const kind = matched?.kind || "explicit_memory";
  const reason = matched?.reason || "explicit_remember_request";
  const ttlDays = retentionDays(kind);
  return Object.freeze({
    action: "upsert",
    shouldWrite: true,
    kind,
    content: candidate.slice(0, 1200),
    memoryKey: `${kind}:${memorySubject(kind, candidate)}`,
    reason,
    importance: matched?.importance || 0.85,
    confidence: explicit ? 1 : 0.9,
    ttlDays,
    policyVersion: MEMORY_POLICY_VERSION
  });
}

export function memoryPolicyStatus() {
  return {
    version: MEMORY_POLICY_VERSION,
    capture: "deterministic-user-authored",
    kinds: [...TYPE_RULES.map(rule => rule.kind), "explicit_memory"],
    retention_days: {
      profile: config.database.memoryProfileRetentionDays,
      preference: config.database.memoryRetentionDays,
      constraint: config.database.memoryRetentionDays,
      explicit_memory: config.database.memoryRetentionDays
    },
    sensitive_content: "reject",
    assistant_claims: "never-promote"
  };
}
