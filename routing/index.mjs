import { createAgentRouter } from "./agent-router.mjs";
import { loadRoutingConfiguration, validateRoutingConfiguration } from "./config-loader.mjs";
import { createDeploymentRouter } from "./deployment-router.mjs";
import { createIntentRouter } from "./intent-router.mjs";
import { createModelRouter } from "./model-router.mjs";

export { loadRoutingConfiguration, validateRoutingConfiguration };

export function createRoutingSystem({
  configuration = loadRoutingConfiguration(),
  agents = [],
  environment = process.env,
  selectableModelAliases = [],
  selectionModeAliases = [],
  modelDescriptors = [],
  modelRouterNow = () => Date.now()
} = {}) {
  validateRoutingConfiguration(configuration);
  const available = [...new Set(
    Object.values(configuration.deploymentRouting.profiles)
      .flatMap(profile => Object.keys(profile.modelAliases || {}))
  )];
  return Object.freeze({
    schemaVersion: "copilot-routing-system.v2",
    intent: createIntentRouter(configuration.intentRouting),
    agent: createAgentRouter(configuration.agentRouting, agents),
    model: createModelRouter(configuration.modelRouting, {
      selectableModelAliases,
      selectionModeAliases,
      availableModelAliases: available,
      modelDescriptors,
      now: modelRouterNow
    }),
    deployment: createDeploymentRouter(configuration.deploymentRouting, environment)
  });
}
