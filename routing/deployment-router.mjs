import { matchesConditions, orderedRules } from "./match.mjs";

function withoutTrailingSlash(value) {
  return String(value || "").trim().replace(/\/$/u, "");
}

export function createDeploymentRouter(configuration, environment = process.env) {
  const rules = orderedRules(configuration.rules);
  const credentialsByProfile = new Map();
  return Object.freeze({
    version: configuration.version,
    route({ workload, modelRoute = null }) {
      const matched = rules.find(rule => matchesConditions(rule.when, { workload })) || null;
      if (!matched) throw new Error(`没有可用于 ${workload} 的 Deployment Route`);
      const profile = configuration.profiles[matched.profileId];
      const baseUrl = withoutTrailingSlash(environment[profile.baseUrlEnv] || profile.defaultBaseUrl);
      if (!baseUrl) throw new Error(`Deployment Profile ${matched.profileId} 缺少 Base URL`);
      const modelEnvironmentName = modelRoute ? profile.modelAliasEnvs?.[modelRoute.modelAlias] : null;
      const configuredModel = modelRoute ? profile.modelAliases?.[modelRoute.modelAlias] : null;
      if (modelRoute && !configuredModel) {
        throw new Error(`Deployment Profile ${matched.profileId} 未映射模型 Alias ${modelRoute.modelAlias}`);
      }
      const model = modelRoute ? environment[modelEnvironmentName] || configuredModel : null;
      credentialsByProfile.set(matched.profileId, {
        apiKey: String(environment[profile.apiKeyEnv] || ""),
        baseUrl
      });
      return Object.freeze({
        schemaVersion: "copilot-deployment-route.v1",
        routerVersion: configuration.version,
        ruleId: matched.id,
        profileId: matched.profileId,
        kind: profile.kind,
        workload,
        baseUrl,
        model,
        credentialRef: profile.apiKeyEnv
      });
    },
    credentials(route) {
      const value = credentialsByProfile.get(route.profileId);
      if (!value) throw new Error(`Deployment Route ${route.profileId} 尚未解析`);
      return Object.freeze({ ...value });
    }
  });
}
