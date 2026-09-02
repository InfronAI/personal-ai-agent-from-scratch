import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentRegistry, agentRegistryStatus, registeredAgent } from "./agents/registry.mjs";
import { config as runtimeConfig } from "./config.mjs";
import { modelCatalog } from "./model-catalog.mjs";
import { createRoutingSystem, loadRoutingConfiguration } from "./routing/index.mjs";

const workflowPath = fileURLToPath(new URL("./config/workflow.config.json", import.meta.url));
const workflowConfiguration = JSON.parse(readFileSync(workflowPath, "utf8"));
if (workflowConfiguration.schemaVersion !== "copilot-workflow-config.v1") {
  throw new Error(`不支持的 Workflow 配置协议：${workflowConfiguration.schemaVersion || "missing"}`);
}

const routingPath = process.env.COPILOT_ROUTING_CONFIG
  || resolve(dirname(workflowPath), workflowConfiguration.routingConfiguration);
export const routingConfiguration = loadRoutingConfiguration(routingPath);
const selectableModels = modelCatalog.models.filter(model => model.kind !== "control-model");
export const routingSystem = createRoutingSystem({
  configuration: routingConfiguration,
  agents: agentRegistry.agents,
  environment: process.env,
  selectableModelAliases: selectableModels.filter(model => model.kind === "answer-model").map(model => model.modelAlias),
  selectionModeAliases: selectableModels.filter(model => model.kind === "selection-mode").map(model => model.modelAlias),
  modelDescriptors: modelCatalog.models.filter(model => model.kind !== "selection-mode")
});

export const agentWorkflow = Object.freeze({
  schemaVersion: workflowConfiguration.schemaVersion,
  workflowVersion: workflowConfiguration.workflowVersion,
  invocationName: workflowConfiguration.invocationName,
  stages: Object.freeze([...workflowConfiguration.stages]),
  rootAgentId: agentRegistry.rootAgentId,
  agentRegistryVersion: agentRegistry.registryVersion,
  capabilityRegistryVersion: agentRegistry.capabilityRegistryVersion,
  agents: new Map(agentRegistry.agents.map(agent => [agent.id, registeredAgent(agent.id, {}, { artifactLimit: runtimeConfig.artifacts.listLimit })]))
});

export function workflowAgent(agentId, context = {}) {
  return registeredAgent(agentId, context, { artifactLimit: runtimeConfig.artifacts.listLimit });
}

export function workflowStatus() {
  const intentModel = routingSystem.model.route({ role: "intent" });
  const specialistModel = routingSystem.model.route({ role: "specialist" });
  const llmDeployment = routingSystem.deployment.route({ workload: "llm", modelRoute: intentModel });
  const searchDeployment = routingSystem.deployment.route({ workload: "search" });
  return {
    schemaVersion: agentWorkflow.schemaVersion,
    workflowVersion: agentWorkflow.workflowVersion,
    invocationName: agentWorkflow.invocationName,
    stages: agentWorkflow.stages,
    agentRegistry: agentRegistryStatus(),
    routing: {
      schemaVersion: routingConfiguration.schemaVersion,
      intentVersion: routingSystem.intent.version,
      agentVersion: routingSystem.agent.version,
      modelVersion: routingSystem.model.version,
      deploymentVersion: routingSystem.deployment.version
    },
    models: {
      intentAlias: intentModel.modelAlias,
      specialistAlias: specialistModel.modelAlias,
      intentPolicyId: intentModel.policyId,
      specialistPolicyId: specialistModel.policyId,
      catalogVersion: modelCatalog.catalogVersion,
      selectableCount: selectableModels.length,
      automaticSelection: {
        modeId: modelCatalog.defaultModelId,
        resolvedBy: "model-router",
        strategy: routingConfiguration.modelRouting.selectionStrategy,
        scoringWeights: Object.freeze({ ...routingConfiguration.modelRouting.scoring.weights }),
        minimumObservations: routingConfiguration.modelRouting.scoring.minimumObservations,
        circuitBreaker: Object.freeze({ ...routingConfiguration.modelRouting.scoring.circuitBreaker }),
        explorationEnabled: routingConfiguration.modelRouting.scoring.exploration.enabled
      },
      runtimeEvidence: routingSystem.model.status()
    },
    setup: {
      onboardingVersion: runtimeConfig.setup.onboardingVersion,
      webConfigurationEnabled: runtimeConfig.setup.webConfigurationEnabled,
      judgeModelEnvironmentKey: runtimeConfig.setup.judgeModelEnvironmentKey
    },
    deployment: {
      profileId: llmDeployment.profileId,
      kind: llmDeployment.kind,
      baseUrl: llmDeployment.baseUrl,
      model: llmDeployment.model,
      credentialRef: llmDeployment.credentialRef
    },
    searchDeployment: {
      profileId: searchDeployment.profileId,
      kind: searchDeployment.kind,
      baseUrl: searchDeployment.baseUrl,
      credentialRef: searchDeployment.credentialRef
    }
  };
}
