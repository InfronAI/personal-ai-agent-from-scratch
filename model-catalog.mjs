import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AppError } from "./errors.mjs";

const catalogPath = fileURLToPath(new URL("./config/model-catalog.config.json", import.meta.url));
const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
const allowedModalities = new Set(["text", "image", "file", "audio", "video"]);

function requireText(value, location) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} 必须是非空字符串`);
}

export function validateModelCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型目录必须是对象");
  if (value.schemaVersion !== "copilot-model-catalog.v3") throw new Error("模型目录协议必须是 copilot-model-catalog.v3");
  requireText(value.catalogVersion, "catalogVersion");
  requireText(value.defaultModelId, "defaultModelId");
  if (!Array.isArray(value.models) || value.models.length < 2) throw new Error("模型目录至少需要两个模型");
  const ids = new Set();
  const aliases = new Set();
  for (const [index, model] of value.models.entries()) {
    for (const field of ["id", "kind", "modelAlias", "displayName", "providerLabel", "description", "mark"]) {
      requireText(model?.[field], `models[${index}].${field}`);
    }
    if (!["selection-mode", "answer-model", "control-model"].includes(model.kind)) throw new Error(`模型 ${model.id} 的 kind 无效`);
    if (ids.has(model.id)) throw new Error(`模型目录包含重复 ID：${model.id}`);
    if (aliases.has(model.modelAlias)) throw new Error(`模型目录包含重复 Alias：${model.modelAlias}`);
    ids.add(model.id);
    aliases.add(model.modelAlias);
    if (!Array.isArray(model.modalities) || !model.modalities.length || model.modalities.some(item => !allowedModalities.has(item))) {
      throw new Error(`模型 ${model.id} 的 modalities 无效`);
    }
    if (!Array.isArray(model.recommendedFor) || !model.recommendedFor.length) throw new Error(`模型 ${model.id} 缺少 recommendedFor`);
  }
  if (!ids.has(value.defaultModelId)) throw new Error(`默认模型 ${value.defaultModelId} 不存在`);
  const defaultModel = value.models.find(model => model.id === value.defaultModelId);
  if (defaultModel.kind !== "selection-mode") throw new Error("默认目录项必须是 selection-mode");
  if (value.models.filter(model => model.kind === "selection-mode").length !== 1) throw new Error("模型目录必须且只能包含一个 selection-mode");
  if (!value.models.some(model => model.kind === "answer-model")) throw new Error("模型目录至少需要一个 answer-model");
  return value;
}

const validated = validateModelCatalog(raw);
const byId = new Map(validated.models.map(model => [model.id, Object.freeze({ ...model, modalities: Object.freeze([...model.modalities]), recommendedFor: Object.freeze([...model.recommendedFor]) })]));
const selectableById = new Map([...byId].filter(([, model]) => model.kind !== "control-model"));

export const modelCatalog = Object.freeze({
  schemaVersion: validated.schemaVersion,
  catalogVersion: validated.catalogVersion,
  defaultModelId: validated.defaultModelId,
  models: Object.freeze([...byId.values()])
});

export function selectedModel(modelId) {
  const id = String(modelId || modelCatalog.defaultModelId).trim();
  const model = selectableById.get(id);
  if (!model) {
    throw new AppError(`不支持的模型：${id || "missing"}`, { code: "invalid_model", status: 400, expose: true });
  }
  return model;
}

export function publicModelCatalog() {
  return {
    schemaVersion: modelCatalog.schemaVersion,
    catalogVersion: modelCatalog.catalogVersion,
    defaultModelId: modelCatalog.defaultModelId,
    models: [...selectableById.values()].map(model => ({ ...model }))
  };
}
