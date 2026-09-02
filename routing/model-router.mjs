import { AppError } from "../errors.mjs";
import { matchesConditions, orderedRules } from "./match.mjs";

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function uniqueModalities(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || "").trim()).filter(Boolean))];
}

function stableFraction(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

function priorityScore(index, total) {
  return rounded(1 - index / (Math.max(1, total) * 2));
}

function latencyScore(latencyMs, configuration) {
  if (!Number.isFinite(latencyMs)) return configuration.neutralEvidenceScore;
  if (latencyMs <= configuration.latencyTargetMs) return 1;
  return rounded(1 - clamp(
    (latencyMs - configuration.latencyTargetMs)
      / (configuration.latencyCeilingMs - configuration.latencyTargetMs)
  ));
}

function frozenCandidates(values) {
  return Object.freeze(values.map(value => Object.freeze({
    ...value,
    missingModalities: Object.freeze([...(value.missingModalities || [])]),
    exclusionReasons: Object.freeze([...(value.exclusionReasons || [])]),
    runtimeEvidence: Object.freeze({ ...(value.runtimeEvidence || {}) }),
    scoreBreakdown: Object.freeze({ ...(value.scoreBreakdown || {}) })
  })));
}

export function createModelRouter(configuration, {
  selectableModelAliases = [],
  selectionModeAliases = [],
  availableModelAliases = [],
  modelDescriptors = [],
  now = () => Date.now()
} = {}) {
  const rules = orderedRules(configuration.rules);
  const selectable = new Set(selectableModelAliases);
  const selectionModes = new Set(selectionModeAliases);
  const available = new Set(availableModelAliases);
  const descriptorByAlias = new Map(modelDescriptors.map(model => [model.modelAlias, model]));
  const observations = new Map();
  const scoring = configuration.scoring;

  function evidence(modelAlias, timestamp) {
    const value = observations.get(modelAlias) || {
      observations: 0,
      successes: 0,
      consecutiveFailures: 0,
      ewmaLatencyMs: null,
      cooldownUntilMs: 0,
      lastErrorCode: null
    };
    return {
      observationCount: value.observations,
      successRate: value.observations ? rounded(value.successes / value.observations) : null,
      consecutiveFailures: value.consecutiveFailures,
      ewmaLatencyMs: Number.isFinite(value.ewmaLatencyMs) ? Math.round(value.ewmaLatencyMs) : null,
      evidenceReady: value.observations >= scoring.minimumObservations,
      circuitOpen: value.cooldownUntilMs > timestamp,
      cooldownUntil: value.cooldownUntilMs > timestamp ? new Date(value.cooldownUntilMs).toISOString() : null,
      lastErrorCode: value.lastErrorCode
    };
  }

  function observe({ modelAlias, success, latencyMs = null, errorCode = null }) {
    const alias = String(modelAlias || "").trim();
    if (!available.has(alias)) return null;
    const timestamp = now();
    const previous = observations.get(alias) || {
      observations: 0,
      successes: 0,
      consecutiveFailures: 0,
      ewmaLatencyMs: null,
      cooldownUntilMs: 0,
      lastErrorCode: null
    };
    const succeeded = success === true;
    const measuredLatency = Number(latencyMs);
    const next = {
      observations: previous.observations + 1,
      successes: previous.successes + (succeeded ? 1 : 0),
      consecutiveFailures: succeeded ? 0 : previous.consecutiveFailures + 1,
      ewmaLatencyMs: previous.ewmaLatencyMs,
      cooldownUntilMs: succeeded ? 0 : previous.cooldownUntilMs,
      lastErrorCode: succeeded ? null : String(errorCode || "model-call-failed")
    };
    if (succeeded && Number.isFinite(measuredLatency) && measuredLatency >= 0) {
      next.ewmaLatencyMs = Number.isFinite(previous.ewmaLatencyMs)
        ? scoring.ewmaAlpha * measuredLatency + (1 - scoring.ewmaAlpha) * previous.ewmaLatencyMs
        : measuredLatency;
    }
    if (!succeeded && next.consecutiveFailures >= scoring.circuitBreaker.failureThreshold) {
      next.cooldownUntilMs = timestamp + scoring.circuitBreaker.cooldownMs;
    }
    observations.set(alias, next);
    return Object.freeze(evidence(alias, timestamp));
  }

  function route({
    role,
    intent = null,
    agentId = null,
    requestedModelAlias = null,
    requiredModalities = [],
    routingKey = null
  }) {
    const matched = rules.find(rule => matchesConditions(rule.when, { role, intent, agentId })) || null;
    const basePolicyId = matched?.policyId || configuration.defaultPolicyId;
    const policy = configuration.policies[basePolicyId];
    if (!policy) throw new Error(`没有可用于 ${role} 的模型 Policy：${basePolicyId}`);

    const requested = String(requestedModelAlias || "").trim();
    const explicit = role !== "intent" && requested && !selectionModes.has(requested);
    if (explicit && !selectable.has(requested)) {
      throw new AppError(`模型 Alias ${requested} 不允许由用户选择`, { code: "invalid_model", status: 400, expose: true });
    }

    const timestamp = now();
    const modalities = uniqueModalities(requiredModalities);
    const candidates = explicit ? [requested] : [...policy.candidateModelAliases];
    const inspected = candidates.map((modelAlias, index) => {
      const descriptor = descriptorByAlias.get(modelAlias) || null;
      const missingModalities = descriptor
        ? modalities.filter(modality => !descriptor.modalities.includes(modality))
        : modalities.length ? [...modalities] : [];
      const availableForDeployment = available.has(modelAlias);
      const runtimeEvidence = evidence(modelAlias, timestamp);
      const compatible = availableForDeployment && missingModalities.length === 0;
      const eligible = compatible && (explicit || !runtimeEvidence.circuitOpen);
      const reliability = runtimeEvidence.evidenceReady
        ? runtimeEvidence.successRate
        : scoring.neutralEvidenceScore;
      const latency = runtimeEvidence.evidenceReady
        ? latencyScore(runtimeEvidence.ewmaLatencyMs, scoring)
        : scoring.neutralEvidenceScore;
      const policyPriority = explicit ? 1 : priorityScore(index, candidates.length);
      const scoreBreakdown = {
        policyPriority,
        reliability,
        latency,
        total: rounded(
          policyPriority * scoring.weights.policyPriority
          + reliability * scoring.weights.reliability
          + latency * scoring.weights.latency
        )
      };
      const exclusionReasons = [];
      if (!availableForDeployment) exclusionReasons.push("deployment-unavailable");
      if (missingModalities.length) exclusionReasons.push("modality-mismatch");
      if (!explicit && runtimeEvidence.circuitOpen) exclusionReasons.push("circuit-open");
      return {
        modelAlias,
        originalIndex: index,
        compatible,
        eligible,
        availableForDeployment,
        capabilityKnown: Boolean(descriptor),
        missingModalities,
        exclusionReasons,
        runtimeEvidence,
        scoreBreakdown
      };
    });
    const ranked = inspected.filter(candidate => candidate.eligible).sort((left, right) => (
      right.scoreBreakdown.total - left.scoreBreakdown.total || left.originalIndex - right.originalIndex
    ));
    if (!ranked.length) {
      const details = { role, policyId: basePolicyId, requiredModalities: modalities, candidates: inspected };
      if (explicit) {
        throw new AppError(`所选模型不支持本轮输入能力：${modalities.join(", ") || "deployment"}`, {
          code: "model_modality_mismatch", status: 400, expose: true, details
        });
      }
      throw new AppError(`Model Router 没有找到兼容 ${modalities.join(", ") || "当前请求"} 的候选模型`, {
        code: "model_route_unavailable", status: 503, retryable: true, expose: true, details
      });
    }

    let selected = ranked[0];
    let explored = false;
    if (!explicit && role !== "intent" && scoring.exploration.enabled && scoring.exploration.rate > 0
      && routingKey && ranked.length > 1
      && stableFraction(`${routingKey}:${basePolicyId}`) < scoring.exploration.rate) {
      selected = ranked[1];
      explored = true;
    }

    const earlierCandidates = inspected.slice(0, selected.originalIndex);
    const selectionReasonCode = explicit
      ? "explicit-user-selection"
      : explored
        ? "controlled-exploration"
        : selected.originalIndex === 0
          ? "hybrid-policy-prior"
          : earlierCandidates.some(candidate => candidate.runtimeEvidence.circuitOpen)
            ? "circuit-breaker-fallback"
            : earlierCandidates.some(candidate => !candidate.compatible)
              ? "capability-fallback"
              : "runtime-evidence-override";
    const selectionMode = explicit ? "explicit" : role === "intent" ? "control" : "model-router";
    return Object.freeze({
      schemaVersion: "copilot-model-route.v3",
      routerVersion: configuration.version,
      ruleId: explicit ? "explicit-user-selection" : matched?.id || null,
      policyId: explicit ? "user-selected" : basePolicyId,
      basePolicyId,
      role,
      agentId,
      modelAlias: selected.modelAlias,
      requestedModelAlias: requested || null,
      selectionMode,
      selectionSource: explicit ? "user" : "policy-and-runtime-evidence",
      selectionStrategy: explicit ? "explicit" : configuration.selectionStrategy,
      selectionReasonCode,
      selectedCandidateIndex: selected.originalIndex,
      requiredModalities: Object.freeze(modalities),
      candidateModelAliases: Object.freeze([...candidates]),
      rankedCandidateAliases: Object.freeze(ranked.map(candidate => candidate.modelAlias)),
      candidateEvaluation: frozenCandidates(inspected),
      parameters: Object.freeze({ temperature: policy.temperature, maxTokens: policy.maxTokens })
    });
  }

  return Object.freeze({
    version: configuration.version,
    route,
    observe,
    status() {
      const timestamp = now();
      return Object.freeze({
        selectionStrategy: configuration.selectionStrategy,
        observedModels: observations.size,
        evidence: Object.freeze(Object.fromEntries([...observations.keys()].map(alias => [alias, evidence(alias, timestamp)])))
      });
    }
  });
}
