export const RUNTIME_EVENT_SCHEMA_VERSION = "copilot-runtime-event.v1";

const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled"]);
const EVENT_KINDS = new Set(["CHAIN", "AGENT RUN", "SPAN", "GENERATION", "TOOL CALL"]);

function isoTime(value) {
  return new Date(value).toISOString();
}

function displayDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return "Running";
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(2)} s` : `${Math.max(0, Math.round(durationMs))} ms`;
}

export function createRuntimeRecorder({
  traceId = null,
  sessionId,
  requestId,
  onEvent = null,
  now = () => Date.now()
}) {
  let currentTraceId = traceId;
  let sequence = 0;
  const events = [];
  const indexes = new Map();

  function setTraceId(value) {
    currentTraceId = String(value || "") || null;
    for (const event of events) event.traceId = currentTraceId;
  }

  function record(candidate) {
    if (!candidate?.id) throw new Error("运行事件必须包含唯一 id");
    if (!EVENT_KINDS.has(candidate.kind)) throw new Error(`不支持的运行事件类型：${candidate.kind}`);
    const timestamp = now();
    const existingIndex = indexes.get(candidate.id);
    const previous = existingIndex === undefined ? null : events[existingIndex];
    const status = candidate.status || previous?.status || "running";
    const terminal = TERMINAL_STATUSES.has(status);
    const startedAt = previous?.startedAt || candidate.startedAt || isoTime(timestamp);
    const startedMs = Date.parse(startedAt);
    const endedAt = terminal ? (candidate.endedAt || isoTime(timestamp)) : null;
    const durationMs = terminal
      ? Math.max(0, Number.isFinite(candidate.durationMs) ? candidate.durationMs : timestamp - startedMs)
      : null;
    const event = {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      sequence: previous?.sequence || ++sequence,
      id: candidate.id,
      parentId: candidate.parentId ?? previous?.parentId ?? null,
      traceId: currentTraceId,
      sessionId,
      requestId,
      kind: candidate.kind,
      name: candidate.name || previous?.name || "unnamed",
      semanticRole: candidate.semanticRole ?? previous?.semanticRole ?? null,
      actor: candidate.actor ?? previous?.actor ?? null,
      status,
      startedAt,
      endedAt,
      durationMs,
      duration: terminal ? displayDuration(durationMs) : "Running",
      summary: candidate.summary ?? previous?.summary ?? "",
      input: candidate.input === undefined ? (previous?.input ?? null) : candidate.input,
      output: candidate.output === undefined ? (previous?.output ?? null) : candidate.output,
      metadata: { ...(previous?.metadata || {}), ...(candidate.metadata || {}) }
    };
    if (existingIndex === undefined) {
      indexes.set(event.id, events.length);
      events.push(event);
    } else events[existingIndex] = event;
    onEvent?.({ type: "span", event: structuredClone(event) });
    return event;
  }

  function snapshot() {
    return events.map(event => structuredClone(event));
  }

  return Object.freeze({ events, record, setTraceId, snapshot });
}

export function validateRuntimeEvents(events) {
  const errors = [];
  const ids = new Set();
  let lastSequence = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event.schemaVersion !== RUNTIME_EVENT_SCHEMA_VERSION) errors.push(`${event.id || "unknown"}: schemaVersion 无效`);
    if (!event.id || ids.has(event.id)) errors.push(`${event.id || "unknown"}: id 缺失或重复`);
    ids.add(event.id);
    if (!EVENT_KINDS.has(event.kind)) errors.push(`${event.id}: kind 无效`);
    if (!Number.isInteger(event.sequence) || event.sequence <= lastSequence) errors.push(`${event.id}: sequence 必须严格递增`);
    lastSequence = event.sequence;
    if (TERMINAL_STATUSES.has(event.status) && (!event.endedAt || !Number.isFinite(event.durationMs))) errors.push(`${event.id}: 终态缺少时间证据`);
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (event.parentId && !ids.has(event.parentId)) errors.push(`${event.id}: parentId ${event.parentId} 不存在`);
  }
  return { valid: errors.length === 0, errors };
}

