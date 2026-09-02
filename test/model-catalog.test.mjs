import assert from "node:assert/strict";
import test from "node:test";

import { modelCatalog, publicModelCatalog, selectedModel } from "../model-catalog.mjs";
import { loadRoutingConfiguration } from "../routing/index.mjs";

test("模型目录把 Model Router 定义为选择模式，并只部署具体逻辑模型", () => {
  const payload = publicModelCatalog();
  assert.equal(payload.schemaVersion, "copilot-model-catalog.v3");
  assert.equal(payload.defaultModelId, "model-router");
  assert.equal(payload.models.length, 16);
  assert.equal(payload.models.filter(model => model.kind === "answer-model").length, 15);
  assert.equal(payload.models.find(model => model.id === "model-router").kind, "selection-mode");
  assert.equal(modelCatalog.models.find(model => model.id === "intention-fast").kind, "control-model");
  assert.equal(new Set(payload.models.map(model => model.id)).size, payload.models.length);
  assert.equal(selectedModel("gemini-3-1-flash-lite").modalities.includes("audio"), true);

  const routing = loadRoutingConfiguration();
  const deployedAliases = routing.deploymentRouting.profiles["llm-primary"].modelAliases;
  for (const model of modelCatalog.models.filter(model => model.kind !== "selection-mode")) assert.ok(deployedAliases[model.modelAlias], model.modelAlias);
  assert.equal(Object.hasOwn(deployedAliases, "model-router"), false);
  assert.equal(deployedAliases["intention-fast"], "google/gemini-3.1-flash-lite");
  assert.throws(() => selectedModel("unknown-model"), /不支持的模型/u);
});
