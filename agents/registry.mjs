import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  capabilityRegistryVersion,
  capabilityTool,
  validateAgentCapabilityNames
} from "../capabilities/registry.mjs";

const registryPath = fileURLToPath(new URL("./registry.json", import.meta.url));
const raw = JSON.parse(readFileSync(registryPath, "utf8"));

if (raw.schemaVersion !== "copilot-agent-registry.v1") {
  throw new Error(`不支持的 Agent Registry 协议：${raw.schemaVersion || "missing"}`);
}

const ids = new Set();
for (const agent of raw.agents || []) {
  if (!/^[a-z][a-z0-9_]{2,63}$/u.test(agent.id || "") || ids.has(agent.id)) {
    throw new Error(`Agent Registry 包含无效或重复 ID：${agent.id || "missing"}`);
  }
  ids.add(agent.id);
}
if (!ids.has(raw.rootAgentId)) throw new Error(`Agent Registry 缺少根 Agent ${raw.rootAgentId}`);
for (const target of (raw.agents.find(agent => agent.id === raw.rootAgentId)?.routableAgentIds || [])) {
  if (!ids.has(target)) throw new Error(`Agent Registry 路由目标 ${target} 不存在`);
}
const capabilityErrors = validateAgentCapabilityNames(raw.agents || []);
if (capabilityErrors.length) throw new Error(`Agent Registry 能力校验失败：${capabilityErrors.join("; ")}`);

const rawById = new Map(raw.agents.map(agent => [agent.id, agent]));

function promptHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeArtifactList(value, limit) {
  if (!Array.isArray(value) || !value.length) return "None";
  return value.slice(0, limit).map(item => {
    if (typeof item === "string") return item;
    return JSON.stringify({
      id: item?.id || item?.artifact_id || null,
      name: item?.name || item?.file_name || item?.title || null,
      title: item?.title || null,
      format: item?.extension || item?.format || null
    });
  }).join("\n");
}

function renderPrompt(template, context, artifactLimit) {
  const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
  const currentTime = Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();
  return String(template || "")
    .replaceAll("{{CURRENT_TIME}}", currentTime)
    .replaceAll("{{ARTIFACT_CATALOG}}", normalizeArtifactList(context.artifacts, artifactLimit))
    .replaceAll("{{NEW_ARTIFACTS}}", normalizeArtifactList(context.newArtifacts, artifactLimit));
}

export const agentRegistry = Object.freeze({
  schemaVersion: raw.schemaVersion,
  registryVersion: raw.registryVersion,
  rootAgentId: raw.rootAgentId,
  capabilityRegistryVersion,
  agents: Object.freeze(raw.agents.map(agent => Object.freeze({
    id: agent.id,
    displayName: agent.displayName,
    description: agent.description || "",
    capabilities: Object.freeze([...(agent.capabilities || [])]),
    routableAgentIds: Object.freeze([...(agent.routableAgentIds || [])]),
    routable: agent.id === raw.rootAgentId || (raw.agents.find(item => item.id === raw.rootAgentId)?.routableAgentIds || []).includes(agent.id)
  })))
});

export function registeredAgent(agentId, context = {}, { artifactLimit = 50 } = {}) {
  const agent = rawById.get(String(agentId || ""));
  if (!agent) return null;
  const systemPrompt = renderPrompt(agent.systemPrompt, context, artifactLimit);
  const directResponsePrompt = agent.directResponsePrompt
    ? renderPrompt(agent.directResponsePrompt, context, artifactLimit)
    : null;
  const root = rawById.get(raw.rootAgentId);
  return Object.freeze({
    id: agent.id,
    name: agent.id,
    displayName: agent.displayName,
    description: agent.description || "",
    systemPromptTemplate: agent.systemPrompt,
    systemPrompt,
    directResponsePrompt,
    promptHash: promptHash(systemPrompt),
    promptTemplateHash: promptHash(agent.systemPrompt),
    directResponsePromptHash: directResponsePrompt ? promptHash(directResponsePrompt) : null,
    capabilities: Object.freeze([...(agent.capabilities || [])]),
    tools: Object.freeze((agent.capabilities || []).map(name => capabilityTool(name, { routableAgents: root.routableAgentIds }))),
    routableAgentIds: Object.freeze([...(agent.routableAgentIds || [])]),
    routableAgents: Object.freeze([...(agent.routableAgentIds || [])])
  });
}

export function agentRegistryStatus() {
  return {
    schemaVersion: agentRegistry.schemaVersion,
    registryVersion: agentRegistry.registryVersion,
    rootAgentId: agentRegistry.rootAgentId,
    capabilityRegistryVersion: agentRegistry.capabilityRegistryVersion,
    agents: agentRegistry.agents.map(agent => ({
      id: agent.id,
      displayName: agent.displayName,
      capabilities: agent.capabilities,
      routableAgentIds: agent.routableAgentIds,
      promptTemplateHash: registeredAgent(agent.id)?.promptTemplateHash
    }))
  };
}
