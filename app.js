import {
  completeCoreSetup,
  createMemory,
  createEvalRun,
  deleteMemory,
  deleteSession,
  fetchArtifacts,
  fetchCurrentUser,
  fetchEvalDatasetItems,
  fetchEvalDatasets,
  fetchEvalRun,
  fetchEvalRuns,
  fetchFeedbackCandidates,
  fetchFeedbackEvidence,
  fetchMemories,
  fetchModelCatalog,
  fetchSetupState,
  fetchSessions,
  loginWithUsername,
  logoutCurrentUser,
  reviewFeedbackCandidate,
  setMemoryEnabled,
  streamChat,
  submitFeedback,
  updateCoreConfiguration,
  updateEvalRun,
  updateGoldenSetLifecycle,
  updateMemory,
  uploadArtifact
} from "./src/web/api-client.mjs";
import { orderedTraceEvents, traceEventForest, upsertRuntimeEvent } from "./src/web/trace-contract.mjs";

const SESSION_CACHE_KEY = "chat.sessions.cache.v3";
const LEGACY_SESSION_CACHE_KEY = "copilot.saved-conversations.v2";
const MAX_SAVED_CONVERSATIONS = 30;
const LOCAL_CACHE_TEXT_LIMIT = 4000;

function conversationStorageKey(userId, namespace = SESSION_CACHE_KEY) {
  return `${namespace}.${String(userId || "signed-out")}`;
}

function loadSavedConversations(userId) {
  try {
    const currentKey = conversationStorageKey(userId);
    const legacyKey = conversationStorageKey(userId, LEGACY_SESSION_CACHE_KEY);
    const serialized = localStorage.getItem(currentKey) || localStorage.getItem(legacyKey) || "[]";
    const value = JSON.parse(serialized);
    if (!Array.isArray(value)) return [];
    if (!localStorage.getItem(currentKey) && serialized !== "[]") {
      localStorage.setItem(currentKey, serialized);
      localStorage.removeItem(legacyKey);
    }
    return value.filter(item => item && typeof item.id === "string" && typeof item.sessionId === "string").slice(0, MAX_SAVED_CONVERSATIONS);
  } catch (error) {
    console.warn("Could not restore saved Personal Copilot conversations:", error.message);
    return [];
  }
}

let savedConversations = [];

function compactCacheText(value, maximum = LOCAL_CACHE_TEXT_LIMIT) {
  const text = String(value || "");
  return text.length > maximum ? text.slice(0, maximum) : text;
}

function cachedConversation(conversation) {
  const retainLocalContent = !conversation.serverBacked && conversation.status !== "completed";
  return {
    cacheVersion: "conversation-cache.v3",
    id: conversation.id,
    sessionId: conversation.sessionId,
    title: compactCacheText(conversation.title, 200) || "New conversation",
    group: conversation.group || "Today",
    prompt: retainLocalContent ? compactCacheText(conversation.prompt) : "",
    answer: retainLocalContent ? compactCacheText(conversation.answer) : "",
    requestId: retainLocalContent ? conversation.requestId || null : null,
    model: conversation.model || "Auto",
    modelId: conversation.modelId || "model-router",
    generated: [],
    runtime: [],
    traces: [],
    status: conversation.status || "draft",
    serverBacked: Boolean(conversation.serverBacked),
    createdAt: conversation.createdAt || null,
    updatedAt: conversation.updatedAt || null
  };
}

function persistConversationCache(userId = state.auth.user?.user_id) {
  if (!userId) return false;
  const key = conversationStorageKey(userId);
  const snapshots = savedConversations.map(cachedConversation);
  try {
    localStorage.setItem(key, JSON.stringify(snapshots));
    return true;
  } catch (error) {
    console.warn("Could not persist the lightweight conversation cache:", error.message);
    try {
      localStorage.removeItem(key);
      const localOnly = snapshots.filter(item => !item.serverBacked && item.status !== "completed");
      if (localOnly.length) localStorage.setItem(key, JSON.stringify(localOnly));
    } catch (fallbackError) {
      console.warn("Conversation cache is unavailable; server history remains authoritative:", fallbackError.message);
    }
    return false;
  }
}

function retainLocalConversation(conversation) {
  return !conversation.serverBacked && conversation.status !== "completed";
}

function allConversations() {
  return [...savedConversations];
}

function findConversation(id) {
  return allConversations().find(item => item.id === id) || null;
}

function saveConversation(conversation) {
  if (!state.auth.user?.user_id || !conversation?.id || !conversation?.sessionId) return;
  const snapshot = {
    ...conversation,
    generated: Array.isArray(conversation.generated) ? conversation.generated : [],
    runtime: Array.isArray(conversation.runtime) ? conversation.runtime : [],
    traces: Array.isArray(conversation.traces) ? conversation.traces : [],
    updatedAt: new Date().toISOString()
  };
  savedConversations = [snapshot, ...savedConversations.filter(item => item.id !== snapshot.id)]
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
    .slice(0, MAX_SAVED_CONVERSATIONS);
  persistConversationCache();
}

function serverConversation(session) {
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const first = turns[0] || {};
  const localId = savedConversations.find(item => item.sessionId === session.id)?.id;
  const traces = turns.map((turn, index) => ({
    clientId: turn.requestId || traceClientId(),
    requestId: turn.requestId || null,
    traceId: turn.traceId || turn.result?.traceId || null,
    turn: index + 1,
    prompt: turn.prompt || "",
    answer: turn.answer || "",
    specialist: turn.result?.specialist || null,
    intent: turn.result?.intent || null,
    model: turn.result?.modelDisplayName || findModel(turn.result?.model).name,
    modelId: turn.result?.model || "model-router",
    inputArtifacts: turn.result?.inputArtifacts || [],
    tool: turn.result?.tool || null,
    runtime: Array.isArray(turn.result?.runtime) ? turn.result.runtime : [],
    status: "completed",
    startedAt: turn.createdAt || session.createdAt,
    completedAt: turn.createdAt || session.updatedAt
  }));
  return {
    id: localId || `server-${session.id}`,
    sessionId: session.id,
    serverBacked: true,
    title: session.title || titleFromPrompt(first.prompt || "New conversation"),
    group: "Today",
    prompt: first.prompt || "",
    answer: first.answer || "",
    requestId: first.requestId || null,
    model: first.result?.modelDisplayName || findModel(first.result?.model).name,
    modelId: first.result?.model || "model-router",
    attachments: first.result?.inputArtifacts || [],
    agent: first.result?.specialist || null,
    tool: first.result?.tool || null,
    traceId: first.traceId || first.result?.traceId || null,
    generated: turns.slice(1).map(turn => ({
      prompt: turn.prompt, answer: turn.answer, requestId: turn.requestId, traceId: turn.traceId || turn.result?.traceId,
      specialist: turn.result?.specialist,
      model: turn.result?.modelDisplayName || findModel(turn.result?.model).name,
      modelId: turn.result?.model || "model-router",
      tool: turn.result?.tool,
      inputArtifacts: turn.result?.inputArtifacts || [],
      runtime: turn.result?.runtime, intent: turn.result?.intent, startedAt: turn.createdAt, completedAt: turn.createdAt
    })),
    runtime: traces.at(-1)?.runtime || [],
    traces,
    status: turns.length ? "completed" : "draft",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

async function hydrateServerConversations() {
  const userId = state.auth.user?.user_id;
  if (!userId) return;
  try {
    const payload = await fetchSessions();
    if (state.auth.user?.user_id !== userId) return;
    const remote = (payload.sessions || []).map(serverConversation);
    const remoteSessionIds = new Set(remote.map(item => item.sessionId));
    savedConversations = [...remote, ...savedConversations.filter(item => !remoteSessionIds.has(item.sessionId) && retainLocalConversation(item))]
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
      .slice(0, MAX_SAVED_CONVERSATIONS);
    render();
    persistConversationCache(userId);
  } catch (error) {
    if (error.status === 401) {
      setSignedOutState();
      render();
      return;
    }
    console.warn("Could not synchronize server conversation history:", error.message);
  }
}

function traceClientId() {
  return `trace-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function sessionTraces(conversation) {
  if (!conversation) return [];
  if (Array.isArray(conversation.traces)) return conversation.traces;
  if (!conversation.prompt) {
    conversation.traces = [];
    return conversation.traces;
  }
  const legacyRuntime = Array.isArray(conversation.runtime) ? conversation.runtime : [];
  conversation.traces = [{
    clientId: traceClientId(),
    requestId: conversation.requestId || null,
    traceId: conversation.traceId || null,
    turn: 1,
    prompt: conversation.prompt,
    answer: conversation.answer || "",
    specialist: conversation.agent || null,
    model: conversation.model || "Auto",
    modelId: conversation.modelId || findModel(conversation.model).id,
    inputArtifacts: conversation.attachments || [],
    tool: conversation.tool || null,
    runtime: legacyRuntime,
    status: conversation.answer ? "completed" : "unknown",
    startedAt: conversation.createdAt || null,
    completedAt: conversation.updatedAt || null
  }];
  (conversation.generated || []).forEach((item, index) => conversation.traces.push({
    clientId: traceClientId(),
    traceId: item.traceId || null,
    turn: index + 2,
    prompt: item.prompt,
    answer: item.answer || "",
    specialist: item.specialist || conversation.agent || null,
    model: item.model || conversation.model || "Auto",
    modelId: item.modelId || findModel(item.model || conversation.model).id,
    inputArtifacts: item.inputArtifacts || [],
    tool: item.tool || null,
    runtime: Array.isArray(item.runtime) ? item.runtime : [],
    status: item.answer ? "completed" : "unknown",
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null
  }));
  return conversation.traces;
}

function persistActiveConversation() {
  const conversation = findConversation(state.activeId);
  if (!conversation) return;
  conversation.generated = [...state.generated];
  saveConversation(conversation);
}

function conversationGroup(conversation) {
  if (!conversation.createdAt) return conversation.group || "Previous 7 days";
  const created = new Date(conversation.createdAt);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(created.getFullYear(), created.getMonth(), created.getDate());
  const difference = Math.round((today - day) / 86_400_000);
  if (difference <= 0) return "Today";
  if (difference === 1) return "Yesterday";
  return "Previous 7 days";
}

function sidebarConversationMeta(conversation) {
  const traces = sessionTraces(conversation);
  if (!traces.length) return "New session";
  const toolCalls = traces.flatMap(trace => trace.runtime || []).filter(event => event.kind === "TOOL CALL").length;
  return `${traces.length} trace${traces.length === 1 ? "" : "s"}${toolCalls ? ` · ${toolCalls} tools` : ""}`;
}

let models = [
  { id: "model-router", kind: "selection-mode", modelAlias: "model-router", name: "Auto", provider: "Model Router", sub: "Selects a concrete model for this request", mark: "router", modalities: ["text", "image", "file", "audio", "video"] }
];

function catalogModel(value) {
  return {
    id: value.id,
    kind: value.kind,
    modelAlias: value.modelAlias,
    name: value.displayName,
    provider: value.providerLabel,
    sub: value.description,
    mark: value.mark,
    modalities: value.modalities || ["text"],
    recommendedFor: value.recommendedFor || []
  };
}

function findModel(value) {
  return models.find(model => model.id === value || model.name === value || model.modelAlias === value) || models[0];
}

const state = {
  auth: {
    status: "loading",
    mode: "local-username",
    user: null,
    error: null
  },
  activeId: null,
  model: models[0],
  sidebarOpen: false,
  sidebarCollapsed: false,
  streaming: false,
  generated: [],
  pendingPrompt: "",
  inspectorOpen: true,
  expandedSpans: ["span-transfer", "span-tool"],
  runtimeCursor: null,
  sessionId: null,
  expandedTraces: [],
  activeTraceClientId: null,
  chatEpoch: 0,
  pendingController: null,
  selectedArtifacts: [],
  uploadingArtifacts: [],
  setup: null,
  currentView: "chat",
  memory: {
    status: "idle",
    payload: null,
    editingId: null,
    query: "",
    kindFilter: "",
    error: null
  },
  evalDatasets: {
    status: "idle",
    catalog: null,
    selectedId: "feedback-golden",
    items: [],
    candidates: [],
    lifecycleStatus: "active",
    tab: "candidates",
    dimensionFilter: "all",
    query: "",
    error: null
  },
  evalRuns: {
    status: "idle",
    payload: null,
    selectedId: null,
    selectedRun: null,
    lifecycle: "active",
    composerOpen: false,
    draft: { name: "", profile: "local", datasetIds: [], automaticName: true },
    error: null
  }
};

const observedRuntime = new Map();
const runtimeRequests = new Set();

const app = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");

const icons = {
  search: '<path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  chat: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3v-7a8 8 0 1 1 18 0Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/>',
  arrow: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
  sliders: '<path d="M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  code: '<path d="m8 9-4 3 4 3m8-6 4 3-4 3m-3-9-2 12"/>',
  research: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 7v8m-4-4h8"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bulb: '<path d="M9 18h6m-5 4h4m4-10a6 6 0 1 0-10.5 4c.8.8 1.5 1.8 1.5 3h6c0-1.2.7-2.2 1.5-3A6 6 0 0 0 18 12Z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4m-6.8 7 6.8 4"/>',
  dots: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/>',
  retry: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.7-2L20 12M4 12l2.2 5a7 7 0 0 0 11.7-2"/>',
  thumbs: '<path d="M7 10v11H3a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h4Zm0 11h9.5a2 2 0 0 0 2-1.7l1.4-7A2 2 0 0 0 18 10h-4l.7-3.5A3 3 0 0 0 12 3L7 10Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  spark: '<path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Zm6 10 .8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8L18 13Z"/>',
  activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m2-10c5 0 5-1 8-1"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m-9 0 1 14h10l1-14M10 11v6m4-6v6"/>',
  dataset: '<path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'
};

function icon(name, cls = "") {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

function productMark(size = "normal") {
  return `<span class="product-mark ${size}" aria-hidden="true"><svg viewBox="0 0 32 32" focusable="false"><path class="product-mark-track" d="M7.7 12.9A9 9 0 0 1 24 14.6"/><path class="product-mark-track" d="M24.3 19.1A9 9 0 0 1 8 17.4"/><circle class="product-mark-node" cx="7.7" cy="12.9" r="2.15"/><circle class="product-mark-node" cx="24.3" cy="19.1" r="2.15"/><path class="product-mark-core" d="m16 11.9 4.1 4.1-4.1 4.1-4.1-4.1Z"/></svg></span>`;
}

function modelMark(mark) {
  if (mark === "router") return `<span class="model-glyph router-glyph">⌁</span>`;
  if (mark === "openai") return `<span class="model-glyph openai-glyph">◉</span>`;
  if (mark === "gemini") return `<span class="model-glyph gemini-glyph">✦</span>`;
  if (mark === "claude") return `<span class="model-glyph claude-glyph">✳</span>`;
  const glyphs = { deepseek: "D", qwen: "Q", kimi: "K", minimax: "M", glm: "G", grok: "𝕏" };
  const safeMark = Object.hasOwn(glyphs, mark) ? mark : "router";
  return `<span class="model-glyph ${safeMark}-glyph">${glyphs[safeMark] || "⌁"}</span>`;
}

function avatarText() {
  return [...String(state.auth.user?.username || "N")][0]?.toUpperCase() || "N";
}

function resetConversationState() {
  state.pendingController?.abort();
  state.pendingController = null;
  state.activeId = null;
  state.generated = [];
  state.pendingPrompt = "";
  state.streaming = false;
  state.runtimeCursor = null;
  state.sessionId = null;
  state.expandedTraces = [];
  state.activeTraceClientId = null;
  state.selectedArtifacts = [];
  state.uploadingArtifacts = [];
  state.chatEpoch += 1;
  observedRuntime.clear();
  runtimeRequests.clear();
}

function resetMemoryPageState() {
  Object.assign(state.memory, {
    status: "idle",
    payload: null,
    editingId: null,
    query: "",
    kindFilter: "",
    error: null
  });
}

function resetEvalRunsPageState() {
  Object.assign(state.evalRuns, {
    status: "idle",
    payload: null,
    selectedId: null,
    selectedRun: null,
    lifecycle: "active",
    composerOpen: false,
    draft: { name: "", profile: "local", datasetIds: [], automaticName: true },
    error: null
  });
}

function activateUser(payload) {
  resetConversationState();
  resetMemoryPageState();
  resetEvalRunsPageState();
  state.setup = null;
  state.auth = {
    status: "authenticated",
    mode: payload.mode || "local-username",
    user: payload.user,
    error: null
  };
  savedConversations = loadSavedConversations(payload.user.user_id);
  const hashMatch = location.hash.match(/^#chat\/(.+)$/);
  state.currentView = location.hash === "#eval-runs" ? "eval-runs" : location.hash === "#eval-datasets" ? "eval-datasets" : location.hash === "#memory" ? "memory" : "chat";
  state.activeId = findConversation(hashMatch?.[1]) ? hashMatch[1] : allConversations()[0]?.id || null;
  const initialConversation = findConversation(state.activeId);
  state.sessionId = initialConversation?.sessionId || null;
  if (!initialConversation) return;
  state.generated = Array.isArray(initialConversation.generated) ? [...initialConversation.generated] : [];
  state.model = findModel(initialConversation.modelId || initialConversation.model);
  const traces = sessionTraces(initialConversation);
  state.expandedTraces = traces.length ? [traces.at(-1).clientId] : [];
  state.activeTraceClientId = traces.at(-1)?.clientId || null;
}

function setSignedOutState(error = null) {
  resetConversationState();
  resetMemoryPageState();
  resetEvalRunsPageState();
  savedConversations = [];
  state.setup = null;
  state.auth = {
    status: "signed-out",
    mode: state.auth.mode || "local-username",
    user: null,
    error
  };
  history.replaceState({}, "", location.pathname || "/");
}

async function bootstrapAuth() {
  try {
    const payload = await fetchCurrentUser();
    if (payload.authenticated && payload.user) {
      activateUser(payload);
      render();
      await Promise.all([hydrateModelCatalog(), hydrateServerConversations()]);
      if (state.currentView === "eval-datasets") await hydrateEvalDatasets();
      if (state.currentView === "eval-runs") await hydrateEvalRuns();
      if (state.currentView === "memory") await hydrateMemoryPage();
      await hydrateSetupState({ showFirstLogin: true });
      return;
    }
    state.auth.mode = payload.mode || "local-username";
    setSignedOutState();
  } catch (error) {
    setSignedOutState(`Could not load sign-in status: ${error.message}`);
  }
  render();
}

async function hydrateModelCatalog() {
  try {
    const payload = await fetchModelCatalog();
    if (!Array.isArray(payload.models) || !payload.models.length) return;
    const selectedId = state.model?.id || payload.defaultModelId;
    models = payload.models.map(catalogModel);
    state.model = findModel(selectedId || payload.defaultModelId);
    render();
  } catch (error) {
    console.warn("Could not load the server model catalog:", error.message);
  }
}

async function hydrateSetupState({ showFirstLogin = false } = {}) {
  try {
    const payload = await fetchSetupState();
    state.setup = payload;
    if (showFirstLogin && !payload.onboarding?.completed) await showSetupWizard({ firstLogin: true, payload });
    return payload;
  } catch (error) {
    console.warn("Could not load first-run setup status:", error.message);
    if (showFirstLogin) toast(`Could not load core configuration: ${error.message}`);
    return null;
  }
}

async function submitLogin(username, button) {
  button.disabled = true;
  state.auth.error = null;
  try {
    const payload = await loginWithUsername(username);
    activateUser(payload);
    render();
    await Promise.all([hydrateModelCatalog(), hydrateServerConversations()]);
    if (state.currentView === "eval-datasets") await hydrateEvalDatasets();
    if (state.currentView === "eval-runs") await hydrateEvalRuns();
    if (state.currentView === "memory") await hydrateMemoryPage();
    await hydrateSetupState({ showFirstLogin: true });
  } catch (error) {
    state.auth.error = error.message;
    render();
  }
}

async function signOut() {
  try {
    await logoutCurrentUser();
  } catch (error) {
    toast(`Sign out failed: ${error.message}`);
    return;
  }
  setSignedOutState();
  closeModal();
  render();
}

function renderAuthScreen() {
  if (state.auth.status === "loading") {
    return `<main class="auth-shell"><div class="auth-loading">${productMark("headline")}<span>Loading your local workspace…</span></div></main>`;
  }
  const managed = state.auth.mode === "trusted-header";
  return `<main class="auth-shell">
    <section class="login-card" aria-labelledby="login-title">
      <div class="login-brand">${productMark("headline")}<span>Personal Copilot</span></div>
      <p class="login-eyebrow">LOCAL USER SPACE</p>
      <h1 id="login-title">${managed ? "Waiting for identity provider" : "Enter your workspace"}</h1>
      <p>${managed
        ? "This environment receives identity from a trusted proxy. Open it through the protected entry point."
        : "Choose a username to continue. Sessions, memories, artifacts, feedback, and trace access are isolated by username."}</p>
      ${managed ? "" : `
        <form class="login-form" data-login-form>
          <label for="copilot-username">Username</label>
          <input id="copilot-username" name="username" type="text" minlength="2" maxlength="32"
            autocomplete="username" autocapitalize="none" placeholder="For example: andrew" required autofocus />
          <button type="submit">Sign in to Personal Copilot</button>
        </form>
        <small>This local MVP does not use passwords. Anyone who knows the same username can enter that workspace, so do not treat it as production authentication.</small>
      `}
      ${state.auth.error ? `<div class="login-error" role="alert">${escapeHtml(state.auth.error)}</div>` : ""}
    </section>
  </main>`;
}

function bindAuthEvents() {
  const form = document.querySelector("[data-login-form]");
  if (!form) return;
  form.addEventListener("submit", event => {
    event.preventDefault();
    const input = form.querySelector("input[name='username']");
    const button = form.querySelector("button[type='submit']");
    if (!input.value.trim()) return;
    void submitLogin(input.value.trim(), button);
  });
}

function renderSidebar() {
  const catalog = allConversations();
  const history = ["Today", "Yesterday", "Previous 7 days"].map(group => {
    const grouped = catalog.filter(item => conversationGroup(item) === group);
    const rows = grouped.map(item => `
      <div class="history-row ${state.activeId === item.id ? "active" : ""}">
        <button class="history-open" data-open-chat="${item.id}" title="${escapeHtml(item.title)}">
          <span class="history-mark">${icon("chat")}</span>
          <span class="history-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(sidebarConversationMeta(item))}</small></span>
          <span class="history-state ${item.status || "completed"}" aria-label="${escapeHtml(item.status || "completed")}"></span>
        </button>
        <button class="history-delete" data-delete-session="${item.id}" aria-label="Delete conversation ${escapeHtml(item.title)}" title="Delete conversation">${icon("trash")}</button>
      </div>`).join("");
    return rows ? `<section class="history-group"><div class="history-label"><span>${group}</span><small>${grouped.length}</small></div>${rows}</section>` : "";
  }).join("");
  return `
    <aside class="sidebar ${state.sidebarCollapsed ? "collapsed" : ""} ${state.sidebarOpen ? "mobile-open" : ""}">
      <div class="sidebar-top">
        <button class="brand" data-new-chat aria-label="Personal Copilot home">${productMark()}<span>Personal Copilot</span></button>
        <div class="sidebar-tools">
          <button class="icon-button" data-search aria-label="Search chats">${icon("search")}</button>
          <button class="icon-button desktop-only" data-collapse aria-label="Collapse sidebar">${icon("panel")}</button>
          <button class="icon-button mobile-close" data-mobile-close aria-label="Close sidebar">${icon("close")}</button>
        </div>
      </div>
      <button class="new-chat" data-new-chat>${icon("compose")}<span>New Chat</span><kbd>⌘ K</kbd></button>
      <div class="nav-section-label">Workspace</div>
      <nav class="primary-nav" aria-label="Primary navigation">
        <button class="primary-nav-item ${state.currentView === "memory" ? "active" : ""}" data-memory-manager title="Manage long-term memory">${icon("bulb")}<span>Memory</span></button>
        <button class="primary-nav-item nav-datasets ${state.currentView === "eval-datasets" ? "active" : ""}" data-eval-datasets title="Manage evaluation datasets">${icon("dataset")}<span>Eval Datasets</span></button>
        <button class="primary-nav-item nav-evaluations ${state.currentView === "eval-runs" ? "active" : ""}" data-eval-runs title="Manage evaluation runs">${icon("activity")}<span>Eval Runs</span></button>
      </nav>
      <div class="history-heading"><span>Conversations</span><small>${catalog.length}</small></div>
      <div class="history-scroll">
        ${history}
      </div>
      <button class="account" data-account-menu>
        <span class="avatar">${escapeHtml(avatarText())}<i></i></span>
        <span class="account-copy"><strong>${escapeHtml(state.auth.user?.username || "Local user")}</strong><small>Local workspace</small></span>
        ${icon("dots")}
      </button>
    </aside>
    <div class="sidebar-scrim ${state.sidebarOpen ? "visible" : ""}" data-mobile-close></div>`;
}

function renderHome() {
  return `
    <section class="home-view">
      <div class="home-center">
        <span class="home-eyebrow">PERSONAL COPILOT</span>
        <h1>What can I help you with?</h1>
        ${renderComposer("hero")}
        <div class="quick-actions">
          <button data-action="research">${icon("research")} Deep research</button>
          <button data-action="analyze">${icon("file")} Analyze documents</button>
          <button data-action="code">${icon("code")} Build software</button>
          <button data-action="explain">${icon("bulb")} Explain a concept</button>
        </div>
      </div>
    </section>`;
}

function renderComposer(position = "dock") {
  const isHero = position === "hero";
  return `
    <form class="composer ${isHero ? "hero-composer" : "dock-composer"}" data-composer>
      <textarea rows="1" maxlength="6000" aria-label="Message Personal Copilot" placeholder="Ask anything${isHero ? ", use @ to tag documents in collections" : ""}"></textarea>
      <input class="file-input" data-file-input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.json,.csv,.mp3,.wav,application/pdf,image/png,image/jpeg,image/webp,text/plain,text/markdown,application/json,text/csv,audio/mpeg,audio/wav" />
      ${state.selectedArtifacts.length || state.uploadingArtifacts.length ? `<div class="selected-artifacts">
        ${state.selectedArtifacts.map(item => `<span title="${escapeHtml(item.file_name)}">${icon(item.mime_type?.startsWith("image/") ? "image" : "file")}<b>${escapeHtml(item.title || item.file_name)}</b><small>${formatBytes(item.size_bytes)}</small><button type="button" data-remove-artifact="${escapeHtml(item.artifact_id)}" aria-label="Remove attachment">${icon("close")}</button></span>`).join("")}
        ${state.uploadingArtifacts.map(item => `<span class="uploading"><i></i><b>${escapeHtml(item.name)}</b><small>Uploading</small></span>`).join("")}
      </div>` : ""}
      <div class="composer-controls">
        <div class="control-left">
          <button type="button" class="round-control" data-attachments aria-label="Add attachments">${icon("plus")}</button>
          <button type="button" class="model-control" data-model-picker>${modelMark(state.model.mark)}<span>${state.model.name}</span>${icon("down")}</button>
        </div>
        <div class="control-right">
          <button type="submit" class="send-control" aria-label="Send message" disabled>${state.streaming ? icon("stop") : icon("arrow")}</button>
        </div>
      </div>
    </form>`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function renderConversation(conversation) {
  const requestId = sessionTraces(conversation)[0]?.requestId || null;
  return `
    <section class="conversation-view">
      <header class="conversation-header">
        <button class="mobile-menu" data-mobile-open aria-label="Open sidebar">${icon("menu")}</button>
        <button class="conversation-model" data-model-picker>${modelMark(state.model.mark)}<span>${escapeHtml(state.model.name)}</span>${icon("down")}</button>
        <div class="header-actions"><button class="runtime-toggle ${state.inspectorOpen ? "active" : ""}" data-runtime-toggle>${icon("activity")}<span>Runtime</span><i></i></button><button class="share-button" data-share>${icon("share")}<span>Share</span></button></div>
      </header>
      <div class="messages-scroll" data-message-scroll>
        <div class="messages">
          <article class="user-message">
            ${renderMessageAttachments(conversation.attachments || [])}
            <div class="user-bubble">${escapeHtml(conversation.prompt)}</div>
          </article>
          <article class="assistant-message">
            <div class="assistant-badge">${productMark("small")}</div>
            <div class="assistant-body">
              ${conversation.agent ? `<div class="agent-route">${icon("spark")} <span>Personal Copilot selected <strong>${conversation.agent}</strong> for this task</span></div>` : ""}
              ${conversation.tool ? renderTool(conversation.tool) : ""}
              <div class="markdown-body">${markdown(conversation.answer)}</div>
              <div class="message-actions">
                <button data-copy-answer aria-label="Copy answer">${icon("copy")}</button>
                <button data-feedback="1" data-feedback-request="${escapeHtml(requestId || "")}" aria-label="Mark response as helpful" ${requestId ? "" : "disabled"}>${icon("thumbs")}</button>
                <button class="thumb-down" data-feedback="0" data-feedback-request="${escapeHtml(requestId || "")}" aria-label="Mark response as unhelpful" ${requestId ? "" : "disabled"}>${icon("thumbs")}</button>
                <span>${conversation.model}</span>
              </div>
            </div>
          </article>
          ${state.generated.map(renderGeneratedMessage).join("")}
          ${state.pendingPrompt ? `<article class="user-message generated-user">${renderMessageAttachments(state.selectedArtifacts)}<div class="user-bubble">${escapeHtml(state.pendingPrompt)}</div></article>` : ""}
          ${state.streaming ? renderThinking() : ""}
        </div>
      </div>
      <div class="composer-dock">${renderComposer("dock")}<p>Personal Copilot can make mistakes. Check important info.</p></div>
    </section>`;
}

function renderMessageAttachments(items = []) {
  if (!Array.isArray(items) || !items.length) return "";
  return `<div class="message-attachments">${items.map(item => {
    const title = escapeHtml(item.file_name || item.title || "Attachment");
    if (item.mime_type?.startsWith("image/") && item.download_url) {
      return `<a class="message-image" href="${escapeHtml(item.download_url)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(item.download_url)}" alt="${title}" /><span>${title}</span></a>`;
    }
    return `<a class="message-file" href="${escapeHtml(item.download_url || "#")}" target="_blank" rel="noreferrer">${icon(item.mime_type?.startsWith("audio/") ? "activity" : "file")}<span><strong>${title}</strong><small>${escapeHtml(item.mime_type || "File")} · ${formatBytes(item.size_bytes)}</small></span></a>`;
  }).join("")}</div>`;
}

function renderTool(tool) {
  if (Array.isArray(tool.artifacts) && tool.artifacts.length) {
    return `<div class="tool-card artifact-result">
      <span class="tool-icon">${icon("file")}</span>
      <span class="tool-copy"><strong>${escapeHtml(tool.title)}</strong><small>${escapeHtml(tool.detail)}</small></span>
      <span class="artifact-links">${tool.artifacts.map(item => `<a href="${escapeHtml(item.download_url)}" download>${escapeHtml(item.file_name)}${icon("down")}</a>`).join("")}</span>
    </div>`;
  }
  return `<button class="tool-card" data-tool-toggle>
    <span class="tool-icon">${icon(tool.title.includes("web") ? "globe" : "file")}</span>
    <span class="tool-copy"><strong>${escapeHtml(tool.title)}</strong><small>${escapeHtml(tool.detail)}</small></span>
    <span class="source-count">${tool.sources || 0} source${tool.sources === 1 ? "" : "s"}</span>${icon("down")}
    <span class="tool-expanded">Personal Copilot reviewed the available sources and used the relevant details to prepare this answer.</span>
  </button>`;
}

function renderGeneratedMessage(item) {
  return `<article class="user-message generated-user">${renderMessageAttachments(item.inputArtifacts || [])}<div class="user-bubble">${escapeHtml(item.prompt)}</div></article>
  <article class="assistant-message"><div class="assistant-badge">${productMark("small")}</div><div class="assistant-body">${item.specialist ? `<div class="agent-route">${icon("spark")} <span>Personal Copilot selected <strong>${escapeHtml(item.specialist)}</strong> for this task</span></div>` : ""}${item.tool ? renderTool(item.tool) : ""}<div class="markdown-body">${markdown(item.answer)}</div><div class="message-actions"><button data-copy-answer>${icon("copy")}</button><button data-feedback="1" data-feedback-request="${escapeHtml(item.requestId || "")}" aria-label="Mark response as helpful" ${item.requestId ? "" : "disabled"}>${icon("thumbs")}</button><button class="thumb-down" data-feedback="0" data-feedback-request="${escapeHtml(item.requestId || "")}" aria-label="Mark response as unhelpful" ${item.requestId ? "" : "disabled"}>${icon("thumbs")}</button><span>${escapeHtml(item.model || state.model.name)}</span></div></div></article>`;
}

function renderThinking() {
  return `<article class="assistant-message thinking-message"><div class="assistant-badge">${productMark("small")}</div><div class="assistant-body"><div class="thinking-line"><span></span><span></span><span></span><em>Thinking</em></div></div></article>`;
}

function mapObservedExecution(trace) {
  const sourceEvents = Array.isArray(trace.events) ? trace.events : [];
  const spanEvents = new Map(sourceEvents.map(event => [event.payload?.span_id, event]).filter(([id]) => id));
  const depthFor = event => {
    let depth = event.event_type === "user_message" ? 0 : 1;
    let parentId = event.payload?.parent_span_id;
    const visited = new Set();
    while (parentId && spanEvents.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = spanEvents.get(parentId)?.payload?.parent_span_id;
    }
    return Math.min(4, depth);
  };
  const mapped = sourceEvents.map((event, index) => {
    const payload = event.payload || {};
    const kindMap = { user_message: "INPUT", chain: "CHAIN", agent: "AGENT RUN", model_call: "GENERATION", span: "SPAN", tool_call: "TOOL CALL", final_answer: "GENERATION" };
    const kind = kindMap[event.event_type] || event.event_type.toUpperCase().replaceAll("_", " ");
    const name = event.name || (event.event_type === "final_answer" ? "final_answer" : event.event_type);
    let rawInput = event.event_type === "user_message"
      ? { role: event.role, prompt: payload.prompt }
      : (event.event_type === "tool_call" ? (payload.tool_arguments || payload.input || payload.prompt) : (payload.input || payload.prompt));
    if (event.event_type === "model_call") {
      rawInput = {
        messages: payload.input || payload.prompt || null,
        model_parameters: payload.model_parameters || {},
        tool_definitions: payload.tool_definitions || {},
        prompt_name: payload.prompt_name || null,
        prompt_version: payload.prompt_version || null
      };
    }
    const rawOutput = event.event_type === "final_answer"
      ? { finish_reason: payload.finish_reason, completion: payload.completion }
      : (event.event_type === "tool_call" ? (payload.tool_result || payload.output || payload.completion) : (payload.output || payload.completion));
    const actor = payload.model || (event.event_type === "agent" ? name.replace(/^agent_run \[|\]$/g, "") : event.role || "Personal Copilot runtime");
    return {
      id: payload.span_id || event.event_id || `observed-${index}`,
      kind,
      name,
      actor,
      duration: formatRuntimeDuration(payload.latency_ms),
      depth: depthFor(event),
      parentId: payload.parent_span_id || null,
      status: event.status === "error" ? "error" : "completed",
      summary: observedEventSummary(event, payload),
      input: compactRuntimeValue(rawInput ?? { captured: payload.content_capture?.input || false }),
      output: compactRuntimeValue(rawOutput ?? { captured: payload.content_capture?.output || false, status: event.status || payload.status_message || "completed" }),
      evidence: event.evidence_level || "observed",
      semanticRole: payload.metadata?.workflow_role || null,
      sourceIndex: index
    };
  });
  const byId = new Map(mapped.map(event => [event.id, event]));
  const children = new Map();
  for (const event of mapped) {
    if (!event.parentId || !byId.has(event.parentId)) continue;
    const items = children.get(event.parentId) || [];
    items.push(event);
    children.set(event.parentId, items);
  }
  const ordered = [];
  const visited = new Set();
  const append = event => {
    if (visited.has(event.id)) return;
    visited.add(event.id);
    ordered.push(event);
    for (const child of (children.get(event.id) || []).sort((left, right) => left.sourceIndex - right.sourceIndex)) append(child);
  };
  for (const event of mapped.filter(item => !item.parentId || !byId.has(item.parentId)).sort((left, right) => left.sourceIndex - right.sourceIndex)) append(event);
  for (const event of mapped) append(event);
  return ordered;
}

function observedEventSummary(event, payload) {
  if (event.event_type === "user_message") return String(payload.prompt || event.content_preview || "User request captured.").slice(0, 160);
  if (event.event_type === "agent") return `${event.name} entered the execution graph.`;
  if (event.event_type === "tool_call") {
    const args = payload.tool_arguments || payload.input;
    return `${event.name} called${args ? " with captured arguments" : ""}.`;
  }
  if (event.event_type === "model_call") return `${payload.model || event.name} generated the next model response.`;
  if (event.event_type === "chain") return "Root orchestration chain for this Personal Copilot request.";
  if (event.event_type === "final_answer") return "Final user-visible completion emitted.";
  return event.name || event.event_type.replaceAll("_", " ");
}

function compactRuntimeValue(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return value;
  if (depth > 10) return "[nested value]";
  if (Array.isArray(value)) return value.map(item => compactRuntimeValue(item, depth + 1));
  const hidden = new Set(["thought_signature"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !hidden.has(key)).map(([key, item]) => [key, compactRuntimeValue(item, depth + 1)]));
}

function formatRuntimeDuration(milliseconds) {
  const value = Number(milliseconds || 0);
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

async function hydrateObservedRuntime(conversation) {
  const candidates = sessionTraces(conversation).filter(trace => trace.traceId && !(trace.runtime || []).length && !observedRuntime.has(trace.traceId) && !runtimeRequests.has(trace.traceId));
  if (!candidates.length) return;
  let refreshed = false;
  for (const candidate of candidates) {
    runtimeRequests.add(candidate.traceId);
    try {
      const response = await fetch(`/api/traces/${encodeURIComponent(candidate.traceId)}`, { headers: { "Accept": "application/json" } });
      if (!response.ok) throw new Error(`Trace API returned ${response.status}`);
      const trace = await response.json();
      const events = mapObservedExecution(trace);
      if (events.length) {
        candidate.runtime = events;
        observedRuntime.set(candidate.traceId, events);
        refreshed = true;
      }
    } catch (error) {
      console.warn("Could not hydrate runtime events from the Trace service:", error.message);
    } finally {
      runtimeRequests.delete(candidate.traceId);
    }
  }
  if (refreshed) {
    saveConversation(conversation);
    if (state.activeId === conversation.id && state.runtimeCursor == null) render();
  }
}

function runtimeForTrace(trace, conversation) {
  if (Array.isArray(trace.runtime) && trace.runtime.length) return orderedTraceEvents(trace.runtime);
  if (trace.traceId && observedRuntime.has(trace.traceId)) return orderedTraceEvents(observedRuntime.get(trace.traceId));
  return [];
}

function traceIntent(events) {
  const agentRoute = [...events].reverse().find(event => event.semanticRole === "agent-routing");
  const routeTarget = agentRoute?.output?.decision?.agentId;
  if (routeTarget) return `Intent routing → Agent routing → ${routeTarget}`;
  const transfer = events.find(event => event.name === "transfer_to_agent");
  const target = transfer?.input?.agent_name || transfer?.input?.agentName;
  if (target) return `Intent routing → ${target}`;
  const routed = events.find(event => event.semanticRole === "intent-routing");
  return routed ? "Intent routing → direct answer" : "Intent routing pending";
}

function isIntentRoutingNode(event, events) {
  if (event.semanticRole === "intent-routing") return true;
  if (event.kind !== "GENERATION") return false;
  return events.some(child => child.parentId === event.id && child.name === "transfer_to_agent");
}

function renderTraceDag(trace, events) {
  if (!events.length) return `<div class="dag-empty"><i></i><span>Waiting for the first Span…</span></div>`;
  const forest = traceEventForest(events);
  const renderNode = node => {
    const event = node.event;
    const kindClass = event.kind.toLowerCase().replaceAll(" ", "-");
    const childrenLabel = node.children.length
      ? `<span class="dag-child-count" title="${node.descendantCount} descendant spans">${node.children.length} ${node.children.length === 1 ? "branch" : "branches"}</span>`
      : "";
    return `<li class="dag-branch ${node.children.length ? "has-children" : "is-leaf"}">
      <button class="trace-dag-node ${event.status || "completed"}" data-dag-span="${escapeHtml(event.id)}" aria-level="${node.depth + 1}">
        <span class="dag-node-marker"><i></i></span>
        <span class="dag-type kind-${kindClass}">${escapeHtml(event.kind === "AGENT RUN" ? "AGENT" : event.kind)}</span>
        <span class="dag-node-copy"><strong>${escapeHtml(event.name)}${isIntentRoutingNode(event, events) ? `<em class="intent-routing-label">INTENT ROUTING</em>` : ""}</strong><small>${escapeHtml(event.actor)}</small></span>
        <span class="dag-node-meta">${childrenLabel}<time>${escapeHtml(event.duration)}</time></span>
      </button>
      ${node.children.length ? `<ol class="dag-children">${node.children.map(renderNode).join("")}</ol>` : ""}
    </li>`;
  };
  return `<div class="trace-dag-tree">
    <div class="dag-structure-summary"><span><i></i>${forest.length} ${forest.length === 1 ? "root" : "roots"}</span><small>Parent → child execution</small></div>
    <ol class="trace-dag-forest">${forest.map(renderNode).join("")}</ol>
  </div>`;
}

function renderSessionTrace(trace, conversation, index, total) {
  const events = runtimeForTrace(trace, conversation);
  const expanded = state.expandedTraces.includes(trace.clientId);
  const agentRuns = events.filter(event => event.kind === "AGENT RUN").length;
  const toolCalls = events.filter(event => event.kind === "TOOL CALL").length;
  const modelCalls = events.filter(event => event.kind === "MODEL" || event.kind === "GENERATION").length;
  const status = trace.status || "completed";
  return `<article class="session-trace ${expanded ? "expanded" : "collapsed"} ${status}" data-session-trace="${trace.clientId}">
    <button class="session-trace-head" data-trace-toggle="${trace.clientId}">
      <span class="trace-turn"><i></i>TRACE ${String(index + 1).padStart(2, "0")}</span>
      <span class="trace-head-copy"><strong>${escapeHtml(trace.prompt || "Pending user turn")}</strong><small><b>${escapeHtml(traceIntent(events))}</b><span>${events.length} spans</span><span>${agentRuns} agents</span></small></span>
      <span class="trace-head-state"><em>${status === "running" ? "LIVE" : "DONE"}</em>${icon("down")}</span>
    </button>
    <div class="session-trace-body">
      <div class="trace-id-row"><span>TRACE ID</span><button data-copy-trace>${escapeHtml(trace.traceId || "allocating…")}${icon("copy")}</button></div>
      <section class="agent-dag">
        <div class="section-heading"><span>AGENT DAG · COMPLETE TRACE</span><small>${icon("branch")} ${events.length} nodes</small></div>
        <div data-trace-dag="${trace.clientId}">${renderTraceDag(trace, events)}</div>
      </section>
      <section class="runtime-timeline">
        <div class="section-heading"><span>SPAN DETAILS</span><small>${modelCalls} model · ${toolCalls} tool</small></div>
        <div class="timeline-list" data-trace-timeline="${trace.clientId}">${events.map((event, eventIndex) => renderRuntimeEvent(event, eventIndex, event.status === "running")).join("")}</div>
      </section>
    </div>
  </article>`;
}

function renderRuntimeInspector(conversation) {
  if (!conversation || !state.inspectorOpen) return "";
  const traces = sessionTraces(conversation);
  if (traces.length && !state.expandedTraces.length) state.expandedTraces = [traces.at(-1).clientId];
  const allEvents = traces.flatMap(trace => runtimeForTrace(trace, conversation));
  const isRunning = traces.some(trace => trace.status === "running");
  const agentRuns = allEvents.filter(event => event.kind === "AGENT RUN").length;
  const toolCalls = allEvents.filter(event => event.kind === "TOOL CALL").length;
  const modelCalls = allEvents.filter(event => event.kind === "MODEL" || event.kind === "GENERATION").length;
  return `<aside class="runtime-inspector ${isRunning ? "is-running" : ""}">
    <header class="runtime-header">
      <div><span class="eyebrow">SESSION RUNTIME</span><h2>Trace log</h2></div>
      <div class="runtime-head-actions"><span class="run-status"><i></i>${isRunning ? "Running" : "Completed"}</span><button data-runtime-close aria-label="Close runtime">${icon("close")}</button></div>
    </header>
    <div class="runtime-scroll">
      <section class="trace-identity">
        <div><span>SESSION</span><button data-copy-session>${escapeHtml(conversation.sessionId || state.sessionId || "new_session")}${icon("copy")}</button></div>
        <strong>${escapeHtml(conversation.title)}</strong><small>${traces.length} traces · ${allEvents.length} spans in this conversation</small>
      </section>
      <section class="runtime-metrics">
        <div><strong data-session-traces-count>${traces.length}</strong><span>Traces</span></div><div><strong data-session-agent-count>${agentRuns}</strong><span>Agent runs</span></div><div><strong data-session-span-count>${allEvents.length}</strong><span>Total spans</span></div>
      </section>
      <section class="session-traces"><div class="section-heading session-heading"><span>SESSION TRACES</span><small>Old traces collapse automatically</small></div>${traces.map((trace, index) => renderSessionTrace(trace, conversation, index, traces.length)).join("")}</section>
    </div>
  </aside><div class="runtime-scrim" data-runtime-close></div>`;
}

function renderRuntimeEvent(event, index, active) {
  const expanded = state.expandedSpans.includes(event.id);
  return `<article class="runtime-event depth-${Math.min(7, event.depth || 0)} ${expanded ? "expanded" : ""} ${active ? "active" : ""}" style="--event-index:${index}" data-runtime-event-id="${escapeHtml(event.id)}">
    <button class="event-summary" data-span-toggle="${event.id}">
      <span class="event-rail"><i></i></span>
      <span class="event-main"><span class="event-top"><span><em class="kind-${event.kind.toLowerCase().replaceAll(" ", "-")}">${event.kind}</em>${event.semanticRole === "intent-routing" ? `<em class="semantic-role">INTENT ROUTING</em>` : ""}</span><time>${escapeHtml(event.duration)}</time></span><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(event.summary)}</small></span>
      ${icon("down")}
    </button>
    <div class="event-detail">
      <div class="actor-row"><span>Executor</span><strong>${escapeHtml(event.actor)}</strong></div>
      ${renderTraceCodeBlock("INPUT", event.input ?? "Waiting…")}
      ${renderTraceCodeBlock("OUTPUT", event.output ?? "Waiting…")}
      <div class="span-foot"><span>SPAN ID</span><code>${event.id}</code></div>
    </div>
  </article>`;
}

function renderTraceCodeBlock(label, value) {
  const code = JSON.stringify(value, null, 2);
  return `<div class="io-block">
    <div class="io-block-head">
      <label>${label}</label>
      <button type="button" data-copy-trace-code aria-label="Copy ${label.toLowerCase()} code" title="Copy code">${icon("copy")}</button>
    </div>
    <pre>${escapeHtml(code)}</pre>
  </div>`;
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function bindTraceCodeCopy(root = document) {
  root?.querySelectorAll?.("[data-copy-trace-code]").forEach(button => {
    if (button.dataset.copyBound) return;
    button.dataset.copyBound = "true";
    button.addEventListener("click", async event => {
      event.stopPropagation();
      const code = button.closest(".io-block")?.querySelector("pre")?.textContent || "";
      await writeClipboard(code);
      button.classList.add("copied");
      button.innerHTML = icon("check");
      button.setAttribute("aria-label", "Code copied");
      button.setAttribute("title", "Copied");
      toast("Code copied");
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.classList.remove("copied");
        button.innerHTML = icon("copy");
        button.setAttribute("aria-label", "Copy code");
        button.setAttribute("title", "Copy code");
      }, 1600);
    });
  });
}

function toggleSpanElement(button) {
  const id = button.dataset.spanToggle;
  const eventElement = button.closest(".runtime-event");
  const expanded = eventElement?.classList.toggle("expanded");
  state.expandedSpans = expanded
    ? [...new Set([...state.expandedSpans, id])]
    : state.expandedSpans.filter(value => value !== id);
}

function refreshRuntimeCounters(conversation) {
  const events = sessionTraces(conversation).flatMap(trace => runtimeForTrace(trace, conversation));
  const agents = events.filter(event => event.kind === "AGENT RUN").length;
  const tracesCount = document.querySelector("[data-session-traces-count]");
  const agentsCount = document.querySelector("[data-session-agent-count]");
  const spansCount = document.querySelector("[data-session-span-count]");
  if (tracesCount) tracesCount.textContent = String(sessionTraces(conversation).length);
  if (agentsCount) agentsCount.textContent = String(agents);
  if (spansCount) spansCount.textContent = String(events.length);
}

function upsertRuntimeSpan(conversation, trace, event) {
  upsertRuntimeEvent(trace.runtime, event);
  if (state.activeId !== conversation.id) return;
  const traceElement = [...document.querySelectorAll("[data-session-trace]")].find(item => item.dataset.sessionTrace === trace.clientId);
  if (!traceElement) return;
  const events = runtimeForTrace(trace, conversation);
  const timeline = traceElement.querySelector("[data-trace-timeline]");
  const oldEvent = [...(timeline?.querySelectorAll("[data-runtime-event-id]") || [])].find(item => item.dataset.runtimeEventId === event.id);
  const eventIndex = events.findIndex(item => item.id === event.id);
  const structuredEvent = events[eventIndex] || event;
  const eventHtml = renderRuntimeEvent(structuredEvent, eventIndex, structuredEvent.status === "running");
  if (oldEvent) oldEvent.outerHTML = eventHtml;
  else timeline?.insertAdjacentHTML("beforeend", eventHtml);
  const newEvent = [...(timeline?.querySelectorAll("[data-runtime-event-id]") || [])].find(item => item.dataset.runtimeEventId === event.id);
  newEvent?.querySelector("[data-span-toggle]")?.addEventListener("click", event => toggleSpanElement(event.currentTarget));
  bindTraceCodeCopy(newEvent);
  const dag = traceElement.querySelector("[data-trace-dag]");
  if (dag) dag.innerHTML = renderTraceDag(trace, events);
  bindDagNodes(dag);
  const intent = traceIntent(events);
  const agents = events.filter(item => item.kind === "AGENT RUN").length;
  const traceMeta = traceElement.querySelector(".trace-head-copy small");
  if (traceMeta) traceMeta.innerHTML = `<b>${escapeHtml(intent)}</b><span>${events.length} spans</span><span>${agents} agents</span>`;
  refreshRuntimeCounters(conversation);
  const scroller = document.querySelector(".runtime-scroll");
  if (scroller && state.activeTraceClientId === trace.clientId) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
}

function bindDagNodes(root = document) {
  root?.querySelectorAll?.("[data-dag-span]").forEach(button => button.addEventListener("click", () => {
    const traceElement = button.closest("[data-session-trace]");
    const eventElement = [...(traceElement?.querySelectorAll("[data-runtime-event-id]") || [])].find(item => item.dataset.runtimeEventId === button.dataset.dagSpan);
    if (!eventElement) return;
    eventElement.classList.add("expanded");
    state.expandedSpans = [...new Set([...state.expandedSpans, button.dataset.dagSpan])];
    eventElement.scrollIntoView({ block: "center", behavior: "smooth" });
  }));
}

function syncLiveTraceIdentity(trace) {
  const traceElement = [...document.querySelectorAll("[data-session-trace]")].find(item => item.dataset.sessionTrace === trace.clientId);
  const button = traceElement?.querySelector(".trace-id-row button");
  if (button) button.innerHTML = `${escapeHtml(trace.traceId || "allocating…")}${icon("copy")}`;
}

const memoryKindLabels = Object.freeze({
  preference: "Long-term preference",
  profile: "User profile",
  constraint: "Long-term constraint",
  explicit_memory: "Explicit memory"
});

function memoryEditorValue(memories) {
  if (!state.memory.editingId) return null;
  if (state.memory.editingId === "new") return {};
  return memories.find(memory => memory.memory_id === state.memory.editingId) || null;
}

function memoryRetentionDays(memory) {
  if (!memory?.expires_at) return 365;
  return Math.max(1, Math.ceil((Date.parse(memory.expires_at) - Date.now()) / 86_400_000));
}

function memoryMatchesFilter(memory) {
  const query = state.memory.query.trim().toLocaleLowerCase();
  const searchable = [memory.content, memoryKindLabels[memory.kind] || memory.kind, memory.updated_at, memory.expires_at].join(" ").toLocaleLowerCase();
  return (!state.memory.kindFilter || memory.kind === state.memory.kindFilter) && (!query || searchable.includes(query));
}

function renderMemoryEditor(memory) {
  if (!memory) return "";
  const formKind = memory.kind || "explicit_memory";
  const formTtl = memoryRetentionDays(memory);
  const editing = Boolean(memory.memory_id);
  return `<section class="memory-editor-card">
    <header><div><strong>${editing ? "Edit memory" : "Add memory"}</strong><span>Store only durable information that should influence future sessions.</span></div><button data-cancel-memory aria-label="Close memory editor">${icon("close")}</button></header>
    <form class="memory-editor" data-memory-editor data-memory-id="${escapeHtml(memory.memory_id || "")}">
      <label class="memory-content-field"><span>Memory</span><textarea name="content" maxlength="1200" required placeholder="For example: I prefer concise answers in English.">${escapeHtml(memory.content || "")}</textarea></label>
      <div><label><span>Type</span><select name="kind">${Object.entries(memoryKindLabels).map(([value, label]) => `<option value="${value}" ${formKind === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label><span>Retention</span><select name="expiresInDays">${[30, 90, 365, 730].map(days => `<option value="${days}" ${Math.abs(formTtl - days) < 3 ? "selected" : ""}>${days} days</option>`).join("")}</select></label></div>
      <footer><button type="button" class="secondary" data-cancel-memory>Cancel</button><button type="submit" class="primary">Save memory</button></footer>
    </form>
  </section>`;
}

function renderMemoryRow(memory) {
  const visible = memoryMatchesFilter(memory);
  return `<article data-memory-row="${escapeHtml(memory.memory_id)}" data-memory-kind="${escapeHtml(memory.kind)}" ${visible ? "" : "hidden"}>
    <span class="memory-kind-mark">${icon(memory.kind === "profile" ? "user" : "bulb")}</span>
    <div><strong>${escapeHtml(memoryKindLabels[memory.kind] || memory.kind)}</strong><p>${escapeHtml(memory.content)}</p><small>Updated ${escapeHtml(memory.updated_at)}${memory.expires_at ? ` · Expires ${escapeHtml(memory.expires_at)}` : ""}${memory.access_count ? ` · Recalled ${memory.access_count} ${memory.access_count === 1 ? "time" : "times"}` : ""}</small></div>
    <span class="memory-actions"><button data-edit-memory="${escapeHtml(memory.memory_id)}" aria-label="Edit memory" title="Edit memory">${icon("compose")}</button><button data-delete-memory="${escapeHtml(memory.memory_id)}" aria-label="Delete memory" title="Delete memory">${icon("trash")}</button></span>
  </article>`;
}

function renderMemoryPage() {
  const payload = state.memory.payload;
  const memories = payload?.memories || [];
  const active = Boolean(payload?.settings?.enabled);
  const recalls = memories.reduce((sum, item) => sum + Number(item.access_count || 0), 0);
  const types = new Set(memories.map(item => item.kind)).size;
  const visibleCount = memories.filter(memoryMatchesFilter).length;
  const editor = memoryEditorValue(memories);
  const body = state.memory.status === "loading" && !payload
    ? `<div class="memory-page-state"><i></i><strong>Loading Memory</strong><span>Retrieving your user-scoped long-term memories.</span></div>`
    : state.memory.status === "error" && !payload
      ? `<div class="memory-page-state error"><strong>Could not load Memory</strong><span>${escapeHtml(state.memory.error || "Unknown error")}</span><button data-retry-memory>Retry</button></div>`
      : `<div class="section-page-content">
        ${renderMemoryEditor(editor)}
        <section class="memory-manager-panel">
          <header class="memory-panel-head"><div><strong>Saved memories</strong><span><b data-memory-visible-count>${visibleCount}</b> of ${memories.length} shown</span></div><div class="memory-inline-stats" aria-label="Memory overview"><span><strong>${recalls}</strong> recalls</span><i></i><span><strong>${types}</strong> types</span></div></header>
          <div class="memory-toolbar">
            <label>${icon("search")}<input data-memory-search placeholder="Search memories" value="${escapeHtml(state.memory.query)}" /></label>
            <select data-memory-filter aria-label="Filter memory type"><option value="">All types</option>${Object.entries(memoryKindLabels).map(([value, label]) => `<option value="${value}" ${state.memory.kindFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select>
            <button class="memory-add" data-add-memory>${icon("plus")} Add memory</button>
          </div>
          <div class="memory-list">${memories.length ? memories.map(renderMemoryRow).join("") : `<div class="memory-empty"><span>${icon("bulb")}</span><strong>No long-term memories</strong><small>Add one manually, or tell Personal Copilot what it should remember for future sessions.</small><button data-add-memory>Add your first memory</button></div>`}</div>
        </section>
      </div>`;
  return `<main class="workspace memory-workspace">
    <header class="conversation-header section-page-header">
      <div class="section-page-title"><button class="mobile-menu" data-mobile-open aria-label="Open sidebar">${icon("menu")}</button><span class="section-page-mark">${icon("bulb")}</span><div><h1>Memory</h1><p>Manage the durable context Personal Copilot can recall across sessions</p></div></div>
      <button class="memory-page-toggle ${active ? "active" : ""}" data-toggle-memory-page aria-pressed="${active}" ${payload ? "" : "disabled"}><i></i><span>${active ? "Memory enabled" : "Memory disabled"}</span></button>
    </header>
    <div class="section-page-scroll">${body}</div>
  </main>`;
}

async function hydrateMemoryPage() {
  state.memory.status = "loading";
  state.memory.error = null;
  render();
  try {
    state.memory.payload = await fetchMemories();
    state.memory.status = "ready";
  } catch (error) {
    state.memory.status = "error";
    state.memory.error = error.message;
  }
  render();
}

async function openMemoryPage(payload = null) {
  closeModal();
  state.currentView = "memory";
  state.sidebarOpen = false;
  history.replaceState({}, "", "#memory");
  if (payload) {
    state.memory.payload = payload;
    state.memory.status = "ready";
    state.memory.error = null;
  }
  render();
  if (!payload) await hydrateMemoryPage();
}

function applyMemoryPageFilter() {
  let visible = 0;
  document.querySelectorAll("[data-memory-row]").forEach(row => {
    const query = state.memory.query.trim().toLocaleLowerCase();
    const matches = (!state.memory.kindFilter || row.dataset.memoryKind === state.memory.kindFilter) && (!query || row.textContent.toLocaleLowerCase().includes(query));
    row.hidden = !matches;
    if (matches) visible += 1;
  });
  const count = document.querySelector("[data-memory-visible-count]");
  if (count) count.textContent = String(visible);
}

function bindMemoryPageEvents() {
  document.querySelector("[data-retry-memory]")?.addEventListener("click", () => void hydrateMemoryPage());
  document.querySelector("[data-toggle-memory-page]")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const enabled = !Boolean(state.memory.payload?.settings?.enabled);
      const result = await setMemoryEnabled(enabled);
      state.memory.payload = { ...state.memory.payload, settings: result.settings };
      toast(enabled ? "Long-term memory enabled" : "Long-term memory disabled");
      render();
    } catch (error) {
      button.disabled = false;
      toast(`Could not update memory settings: ${error.message}`);
    }
  });
  document.querySelectorAll("[data-add-memory]").forEach(button => button.addEventListener("click", () => {
    state.memory.editingId = "new";
    render();
    requestAnimationFrame(() => document.querySelector("[data-memory-editor] textarea")?.focus());
  }));
  document.querySelectorAll("[data-cancel-memory]").forEach(button => button.addEventListener("click", () => {
    state.memory.editingId = null;
    render();
  }));
  document.querySelectorAll("[data-edit-memory]").forEach(button => button.addEventListener("click", () => {
    state.memory.editingId = button.dataset.editMemory;
    render();
    requestAnimationFrame(() => document.querySelector("[data-memory-editor] textarea")?.focus());
  }));
  document.querySelector("[data-memory-editor]")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector("button[type='submit']");
    submit.disabled = true;
    const input = {
      content: form.elements.content.value.trim(),
      kind: form.elements.kind.value,
      expiresInDays: Number(form.elements.expiresInDays.value)
    };
    try {
      if (form.dataset.memoryId) await updateMemory(form.dataset.memoryId, input);
      else await createMemory(input);
      toast(form.dataset.memoryId ? "Memory updated" : "Memory added");
      state.memory.editingId = null;
      await hydrateMemoryPage();
    } catch (error) {
      submit.disabled = false;
      toast(`Could not save memory: ${error.message}`);
    }
  });
  document.querySelectorAll("[data-delete-memory]").forEach(button => button.addEventListener("click", async () => {
    const confirmed = globalThis.confirm?.("Delete this memory? It will no longer be recalled in future sessions.") ?? true;
    if (!confirmed) return;
    button.disabled = true;
    try {
      await deleteMemory(button.dataset.deleteMemory);
      toast("Memory deleted");
      if (state.memory.editingId === button.dataset.deleteMemory) state.memory.editingId = null;
      await hydrateMemoryPage();
    } catch (error) {
      button.disabled = false;
      toast(`Could not delete memory: ${error.message}`);
    }
  }));
  document.querySelector("[data-memory-search]")?.addEventListener("input", event => {
    state.memory.query = event.currentTarget.value;
    applyMemoryPageFilter();
  });
  document.querySelector("[data-memory-filter]")?.addEventListener("change", event => {
    state.memory.kindFilter = event.currentTarget.value;
    applyMemoryPageFilter();
  });
}

const datasetDimensionLabels = Object.freeze({
  user_feedback: "User feedback",
  product_contract: "Product contract",
  general_knowledge: "General knowledge",
  vertical_capability: "Vertical capability",
  performance_resilience: "Performance & resilience",
  safety_compliance: "Safety & compliance",
  agent_capability: "Agent capability"
});

function datasetDimensionLabel(value) {
  return datasetDimensionLabels[value] || String(value || "Unclassified").replaceAll("_", " ");
}

function evalFacetLabel(value) {
  return String(value || "Unspecified").replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function evalFacetEntries(values, limit = 6) {
  return Object.entries(values || {}).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit);
}

function renderEvalFacet(values, emptyText = "Not tagged") {
  const entries = evalFacetEntries(values);
  return entries.length
    ? entries.map(([key, count]) => `<span>${escapeHtml(evalFacetLabel(key))}<b>${count}</b></span>`).join("")
    : `<small>${escapeHtml(emptyText)}</small>`;
}

function visibleEvalDatasets() {
  const datasets = state.evalDatasets.catalog?.datasets || [];
  return state.evalDatasets.dimensionFilter === "all"
    ? datasets
    : datasets.filter(dataset => dataset.evaluation_dimension === state.evalDatasets.dimensionFilter);
}

function renderDatasetCatalogRow(dataset) {
  const active = dataset.id === state.evalDatasets.selectedId;
  return `<button class="eval-dataset-catalog-row ${active ? "active" : ""}" data-select-eval-dataset="${escapeHtml(dataset.id)}" aria-current="${active ? "page" : "false"}">
    <span class="eval-dataset-source ${escapeHtml(dataset.source)}">${dataset.read_only ? "Built-in" : "Feedback"}</span>
    <strong title="${escapeHtml(dataset.name)}">${escapeHtml(dataset.name)}</strong>
    <small title="${escapeHtml(dataset.purpose || "")}">${escapeHtml(dataset.purpose || "No description")}</small>
    <span class="eval-dataset-count" aria-label="${dataset.active_count} active cases"><b>${dataset.active_count}</b><em>cases</em></span>
  </button>`;
}

function renderEvalDatasetCatalog() {
  const datasets = visibleEvalDatasets();
  const order = ["user_feedback", "product_contract", "general_knowledge", "vertical_capability", "performance_resilience", "safety_compliance", "agent_capability"];
  const groups = order.map(dimension => [dimension, datasets.filter(dataset => dataset.evaluation_dimension === dimension)]).filter(([, rows]) => rows.length);
  return groups.length
    ? groups.map(([dimension, rows]) => `<section class="eval-catalog-group"><h3>${escapeHtml(datasetDimensionLabel(dimension))}<span>${rows.length}</span></h3>${rows.map(renderDatasetCatalogRow).join("")}</section>`).join("")
    : `<div class="eval-catalog-empty">No datasets in this dimension.</div>`;
}

function itemPrompt(item) {
  return item.input?.messages?.at(-1)?.content || item.id || "Untitled item";
}

function renderBuiltInEvalItem(item, index) {
  const metadata = item.metadata || {};
  const search = [item.id, item.suite, itemPrompt(item), metadata.task_type, metadata.capability, metadata.domain, metadata.benchmark_family, metadata.workflow_stage, metadata.decision_use, ...(metadata.tags || [])].join(" ").toLowerCase();
  const primaryTags = [
    metadata.benchmark_family ? `<span class="benchmark">${escapeHtml(evalFacetLabel(metadata.benchmark_family))}</span>` : "",
    metadata.difficulty ? `<span>${escapeHtml(evalFacetLabel(metadata.difficulty))}</span>` : "",
    metadata.workflow_stage ? `<span>${escapeHtml(evalFacetLabel(metadata.workflow_stage))}</span>` : "",
    `<span>${metadata.live_eligible ? "Live eligible" : "Offline only"}</span>`
  ].filter(Boolean).join("");
  return `<article class="eval-dataset-item" data-eval-item-id="${escapeHtml(item.id)}" data-eval-search="${escapeHtml(search)}">
    <header>
      <span class="eval-item-index">${String(index + 1).padStart(2, "0")}</span>
      <div><strong>${escapeHtml(itemPrompt(item))}</strong><small><code>${escapeHtml(item.id)}</code> · ${escapeHtml(metadata.task_type || "unknown")}</small></div>
      <span class="eval-risk ${escapeHtml(metadata.risk || "low")}">${escapeHtml(metadata.risk || "low")}</span>
    </header>
    <div class="eval-item-tags">${primaryTags}</div>
    <details class="eval-contract-detail"><summary>Input · Expected output · Metadata ${icon("down")}</summary>
      <div class="eval-contract-grid">
        <section><strong>Input</strong><pre>${escapeHtml(JSON.stringify(item.input, null, 2))}</pre></section>
        <section><strong>Expected contract</strong><pre>${escapeHtml(JSON.stringify(item.expected, null, 2))}</pre></section>
        <section><strong>Metadata</strong><pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre></section>
      </div>
    </details>
  </article>`;
}

function renderGoldenEvalItem(item, index) {
  const metadata = item.metadata || {};
  const search = [item.id, itemPrompt(item), metadata.task_type, ...(metadata.tags || [])].join(" ").toLowerCase();
  const action = item.active ? "archive" : "restore";
  return `<article class="eval-dataset-item golden" data-eval-search="${escapeHtml(search)}" data-golden-item="${escapeHtml(item.golden_id)}">
    <header>
      <span class="eval-item-index">G${String(index + 1).padStart(2, "0")}</span>
      <div><strong>${escapeHtml(itemPrompt(item))}</strong><small><code>${escapeHtml(item.id)}</code> · version ${item.item_version}</small></div>
      <span class="eval-lifecycle ${item.active ? "active" : "archived"}">${item.active ? "Active" : "Archived"}</span>
    </header>
    <div class="eval-item-tags"><span>${escapeHtml(metadata.task_type || "user_feedback_case")}</span><span>${escapeHtml(metadata.risk || "low")} risk</span><span>Human reviewed</span>${metadata.evidence_scope ? "<span>Trace + Session evidence</span>" : ""}</div>
    <details class="eval-contract-detail"><summary>Inspect regression item ${icon("down")}</summary>
      <div class="eval-contract-grid two-column">
        <section><strong>Input</strong><pre>${escapeHtml(JSON.stringify(item.input, null, 2))}</pre></section>
        <section><strong>Expected output</strong><pre>${escapeHtml(JSON.stringify(item.expected, null, 2))}</pre></section>
      </div>
    </details>
    <footer><button class="eval-secondary-action" data-golden-lifecycle="${action}">${action === "archive" ? "Archive item" : "Restore to Active"}</button></footer>
  </article>`;
}

function renderEvalFeedbackCandidate(item, index) {
  const search = [item.id, item.prompt, item.actual_output, item.comment, ...(item.failure_codes || [])].join(" ").toLowerCase();
  return `<article class="golden-candidate eval-review-card" data-golden-candidate="${escapeHtml(item.id)}" data-eval-search="${escapeHtml(search)}">
    <div class="golden-card-head"><span class="golden-index">${String(index + 1).padStart(2, "0")}</span><span class="feedback-label ${item.score_value === 1 ? "positive" : "negative"}">${icon("thumbs")}${item.score_value === 1 ? "Helpful" : "Unhelpful"}</span><code>candidate</code><small>${escapeHtml(item.updated_at)}</small></div>
    <div class="golden-evidence-grid"><label>User input<textarea readonly>${escapeHtml(item.prompt)}</textarea></label><label>Current response<textarea readonly>${escapeHtml(item.actual_output)}</textarea></label></div>
    ${evidenceSummaryMarkup(item)}
    ${item.comment ? `<p class="golden-comment">User note: ${escapeHtml(item.comment)}</p>` : ""}
    <label class="eval-review-expected">Expected answer / acceptance criteria<textarea data-expected-output placeholder="${item.score_value === 1 ? "Leave blank to confirm the current answer" : "Provide the correct answer or explicit acceptance criteria"}"></textarea></label>
    <details class="eval-review-criteria"><summary>Routing and failure criteria <span>Optional</span>${icon("down")}</summary><div class="golden-review-grid compact">
      <label>Failure codes<input data-failure-codes placeholder="answer_incorrect, route_wrong_agent" /></label>
      <label>Expected mode<select data-expected-mode><option value="">Any</option><option value="direct">direct</option><option value="delegate">delegate</option></select></label>
      <label>Expected agent ID<input data-expected-agent placeholder="For example: teaching_assistant" /></label>
    </div></details>
    <div class="golden-actions"><button class="secondary" data-review-reject>Reject</button><button class="primary" data-review-approve>Add to Active Set</button></div>
  </article>`;
}

function renderEvalDatasetDetail() {
  const catalog = state.evalDatasets.catalog?.datasets || [];
  const selected = catalog.find(dataset => dataset.id === state.evalDatasets.selectedId);
  if (!selected) return `<div class="eval-empty"><strong>No dataset selected</strong><span>Select a dataset from the catalog.</span></div>`;
  const feedback = selected.id === "feedback-golden";
  const candidates = state.evalDatasets.candidates || [];
  const items = state.evalDatasets.items || [];
  const coverage = selected.coverage || {};
  const benchmarkReferences = selected.benchmark_references || [];
  const detailFacts = feedback
    ? [[selected.active_count || 0, "Active items"], [candidates.length, "To review"], ["Trace + Session", "Evidence"]]
    : [[selected.active_count || 0, "Cases"], [selected.live_eligible_count || 0, "Live eligible"], [Object.keys(selected.benchmarks || {}).length, "Methods"], [Object.keys(coverage.decision_uses || {}).length, "Decision uses"]];
  const content = state.evalDatasets.tab === "candidates"
    ? candidates.length ? candidates.map(renderEvalFeedbackCandidate).join("") : `<div class="eval-empty"><strong>Review inbox is clear</strong><span>Thumbs feedback will appear here with its frozen Trace and Session evidence.</span></div>`
    : items.length ? items.map((item, index) => feedback ? renderGoldenEvalItem(item, index) : renderBuiltInEvalItem(item, index)).join("") : `<div class="eval-empty"><strong>No ${escapeHtml(state.evalDatasets.lifecycleStatus)} items</strong><span>Change the lifecycle filter or approve a feedback candidate.</span></div>`;
  return `<section class="eval-dataset-detail">
    <header class="eval-detail-head"><div class="eval-detail-heading"><span>${escapeHtml(datasetDimensionLabel(selected.evaluation_dimension))}</span><h2>${escapeHtml(selected.name)}</h2><p>${escapeHtml(selected.purpose)}</p></div><div class="eval-detail-state"><code>${escapeHtml(selected.version)}</code><span class="eval-access">${selected.read_only ? "Version controlled" : "User scoped"}</span></div><div class="eval-detail-facts">${detailFacts.map(([value, label]) => `<span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></span>`).join("")}</div></header>
    ${feedback ? "" : `<details class="eval-dataset-context"><summary><span>Coverage & methodology</span><small>${Object.keys(coverage.capabilities || {}).length} capabilities · ${benchmarkReferences.length} references</small>${icon("down")}</summary><div class="eval-dataset-context-body"><div class="eval-coverage-panel">
      <section><h3>Workflow coverage</h3><div class="eval-facet-list">${renderEvalFacet(coverage.workflow_stages, "Workflow stage not tagged")}</div></section>
      <section><h3>Capabilities</h3><div class="eval-facet-list">${renderEvalFacet(coverage.capabilities)}</div></section>
      <section><h3>Domains</h3><div class="eval-facet-list">${renderEvalFacet(coverage.domains)}</div></section>
    </div>${benchmarkReferences.length ? `<div class="eval-benchmark-sources"><h3>Official benchmark references</h3><div>${benchmarkReferences.map(reference => `<a href="${escapeHtml(reference.official_url || "#")}" target="_blank" rel="noreferrer"><strong>${escapeHtml(reference.name)}</strong><small>${escapeHtml(reference.scope)}</small>${icon("arrow")}</a>`).join("")}</div></div>` : ""}</div></details>`}
    <div class="eval-detail-toolbar">
      ${feedback ? `<div class="eval-tabs" role="tablist"><button class="${state.evalDatasets.tab === "items" ? "active" : ""}" data-eval-tab="items">Dataset items</button><button class="${state.evalDatasets.tab === "candidates" ? "active" : ""}" data-eval-tab="candidates">Review inbox <span>${candidates.length}</span></button></div>` : `<div class="eval-tabs"><span>Published benchmark items</span></div>`}
      <label class="eval-search">${icon("search")}<input data-eval-item-search placeholder="Search cases, tasks, or tags" value="${escapeHtml(state.evalDatasets.query)}" /></label>
      ${feedback && state.evalDatasets.tab === "items" ? `<select data-eval-lifecycle aria-label="Dataset lifecycle filter"><option value="active" ${state.evalDatasets.lifecycleStatus === "active" ? "selected" : ""}>Active</option><option value="archived" ${state.evalDatasets.lifecycleStatus === "archived" ? "selected" : ""}>Archived</option><option value="all" ${state.evalDatasets.lifecycleStatus === "all" ? "selected" : ""}>All items</option></select>` : ""}
      <button class="eval-export" data-export-eval-dataset ${items.length ? "" : "disabled"}>${icon("down")} Export JSONL</button>
    </div>
    <div class="eval-item-list" data-eval-item-list>${content}</div>
  </section>`;
}

function renderEvalDatasetPage() {
  const payload = state.evalDatasets.catalog;
  if (state.evalDatasets.status === "loading" && !payload) return `<main class="workspace eval-workspace"><div class="eval-page-loading"><i></i><strong>Loading Eval Datasets</strong><span>Resolving versioned benchmarks and user-scoped feedback.</span></div></main>`;
  if (state.evalDatasets.status === "error" && !payload) return `<main class="workspace eval-workspace"><div class="eval-page-loading error"><strong>Could not load Eval Datasets</strong><span>${escapeHtml(state.evalDatasets.error || "Unknown error")}</span><button data-retry-eval-datasets>Retry</button></div></main>`;
  const summary = payload?.summary || {};
  const dimensions = [...new Set((payload?.datasets || []).map(dataset => dataset.evaluation_dimension))];
  return `<main class="workspace eval-workspace">
    <header class="conversation-header section-page-header">
      <div class="section-page-title"><button class="mobile-menu" data-mobile-open aria-label="Open sidebar">${icon("menu")}</button><span class="section-page-mark">${icon("dataset")}</span><div><h1>Eval Datasets</h1><p>Versioned benchmarks and human-reviewed regression truth</p></div></div>
      <div class="eval-header-summary" aria-label="Evaluation dataset summary"><span><strong>${summary.datasets || 0}</strong> datasets</span><i></i><span><strong>${summary.built_in_items || 0}</strong> benchmark cases</span><i></i><span class="${summary.feedback_candidates ? "needs-review" : ""}"><strong data-eval-review-count>${summary.feedback_candidates || 0}</strong> to review</span></div>
    </header>
    <div class="section-page-scroll">
      <div class="section-page-content">
        <div class="eval-dataset-layout"><aside class="eval-dataset-catalog"><header><div><span>Dataset catalog</span><small>${summary.datasets || 0}</small></div><select data-eval-dimension-filter aria-label="Filter datasets by evaluation dimension"><option value="all">All dimensions</option>${dimensions.map(dimension => `<option value="${escapeHtml(dimension)}" ${state.evalDatasets.dimensionFilter === dimension ? "selected" : ""}>${escapeHtml(datasetDimensionLabel(dimension))}</option>`).join("")}</select></header><div class="eval-catalog-scroll">${renderEvalDatasetCatalog()}</div></aside>${renderEvalDatasetDetail()}</div>
      </div>
    </div>
  </main>`;
}

function evalDatasetViewportRowKey(element) {
  if (!element?.dataset) return null;
  if (element.dataset.goldenCandidate) return `candidate:${element.dataset.goldenCandidate}`;
  if (element.dataset.goldenItem) return `golden:${element.dataset.goldenItem}`;
  if (element.dataset.evalItemId) return `item:${element.dataset.evalItemId}`;
  return null;
}

function evalDatasetViewportRows() {
  return [...document.querySelectorAll("[data-golden-candidate], [data-golden-item], [data-eval-item-id]")].filter(element => !element.hidden);
}

function captureEvalDatasetViewport({ removingElement = null } = {}) {
  const pageScroller = document.querySelector(".section-page-scroll");
  if (!pageScroller) return null;
  const catalogScroller = document.querySelector(".eval-catalog-scroll");
  const scrollerRect = pageScroller.getBoundingClientRect();
  const rows = evalDatasetViewportRows();
  let anchor = null;
  let anchorOffset = null;
  if (removingElement) {
    const index = rows.indexOf(removingElement);
    anchor = rows[index + 1] || rows[index - 1] || null;
    anchorOffset = removingElement.getBoundingClientRect().top - scrollerRect.top;
  } else {
    anchor = rows.find(element => element.getBoundingClientRect().bottom > scrollerRect.top) || rows[0] || null;
    if (anchor) anchorOffset = anchor.getBoundingClientRect().top - scrollerRect.top;
  }
  return {
    pageTop: Number(pageScroller.scrollTop || 0),
    catalogTop: Number(catalogScroller?.scrollTop || 0),
    anchorKey: evalDatasetViewportRowKey(anchor),
    anchorOffset
  };
}

function restoreEvalDatasetViewport(viewport) {
  if (!viewport) return;
  requestAnimationFrame(() => {
    if (state.currentView !== "eval-datasets") return;
    const pageScroller = document.querySelector(".section-page-scroll");
    if (!pageScroller) return;
    pageScroller.scrollTop = viewport.pageTop;
    const catalogScroller = document.querySelector(".eval-catalog-scroll");
    if (catalogScroller) catalogScroller.scrollTop = viewport.catalogTop;
    if (!viewport.anchorKey || !Number.isFinite(viewport.anchorOffset)) return;
    const anchor = evalDatasetViewportRows().find(element => evalDatasetViewportRowKey(element) === viewport.anchorKey);
    if (!anchor) return;
    const delta = anchor.getBoundingClientRect().top - pageScroller.getBoundingClientRect().top - viewport.anchorOffset;
    if (Number.isFinite(delta) && Math.abs(delta) >= 1) pageScroller.scrollTop += delta;
  });
}

async function hydrateEvalDatasetSelection() {
  const selectedId = state.evalDatasets.selectedId;
  const status = selectedId === "feedback-golden" ? state.evalDatasets.lifecycleStatus : "published";
  const requests = [fetchEvalDatasetItems(selectedId, status)];
  if (selectedId === "feedback-golden") requests.push(fetchFeedbackCandidates());
  const [itemsPayload, candidatesPayload] = await Promise.all(requests);
  state.evalDatasets.items = itemsPayload.items || [];
  state.evalDatasets.candidates = candidatesPayload?.candidates || [];
}

async function hydrateEvalDatasets({ refreshCatalog = true, viewport = captureEvalDatasetViewport() } = {}) {
  state.evalDatasets.status = "loading";
  state.evalDatasets.error = null;
  render({ evalViewport: viewport });
  try {
    if (refreshCatalog || !state.evalDatasets.catalog) state.evalDatasets.catalog = await fetchEvalDatasets();
    const known = state.evalDatasets.catalog.datasets.some(dataset => dataset.id === state.evalDatasets.selectedId);
    if (!known) state.evalDatasets.selectedId = state.evalDatasets.catalog.datasets[0]?.id || "feedback-golden";
    await hydrateEvalDatasetSelection();
    state.evalDatasets.status = "ready";
  } catch (error) {
    state.evalDatasets.status = "error";
    state.evalDatasets.error = error.message;
  }
  render({ evalViewport: viewport });
}

async function openEvalDatasets() {
  state.currentView = "eval-datasets";
  state.sidebarOpen = false;
  history.replaceState({}, "", "#eval-datasets");
  render();
  if (state.evalDatasets.status === "idle" || state.evalDatasets.status === "error") await hydrateEvalDatasets();
}

function filterEvalDatasetRows(query) {
  const normalized = String(query || "").trim().toLowerCase();
  state.evalDatasets.query = query;
  document.querySelectorAll("[data-eval-search]").forEach(row => {
    row.hidden = Boolean(normalized) && !String(row.dataset.evalSearch || "").includes(normalized);
  });
}

function downloadEvalDatasetJsonl() {
  const selected = state.evalDatasets.catalog?.datasets?.find(dataset => dataset.id === state.evalDatasets.selectedId);
  if (!selected || !state.evalDatasets.items.length) return;
  const rows = state.evalDatasets.items.map(item => {
    const copy = structuredClone(item);
    delete copy.golden_id;
    delete copy.candidate_id;
    delete copy.item_version;
    delete copy.active;
    delete copy.lifecycle_status;
    delete copy.updated_at;
    delete copy.dataset_id;
    delete copy.read_only;
    return copy;
  });
  const blob = new Blob([`${rows.map(item => JSON.stringify(item)).join("\n")}\n`], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${selected.id}-${state.evalDatasets.lifecycleStatus}.jsonl`;
  anchor.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${rows.length} Dataset item${rows.length === 1 ? "" : "s"}`);
}

function bindEvalDatasetEvents() {
  document.querySelector("[data-retry-eval-datasets]")?.addEventListener("click", () => void hydrateEvalDatasets());
  document.querySelector("[data-eval-dimension-filter]")?.addEventListener("change", async event => {
    state.evalDatasets.dimensionFilter = event.currentTarget.value;
    const visible = visibleEvalDatasets();
    if (visible.some(dataset => dataset.id === state.evalDatasets.selectedId)) {
      render();
      return;
    }
    const next = visible[0];
    if (!next) {
      render();
      return;
    }
    state.evalDatasets.selectedId = next.id;
    state.evalDatasets.tab = next.id === "feedback-golden" ? "candidates" : "items";
    state.evalDatasets.lifecycleStatus = "active";
    state.evalDatasets.query = "";
    state.evalDatasets.status = "loading";
    render();
    try {
      await hydrateEvalDatasetSelection();
      state.evalDatasets.status = "ready";
    } catch (error) {
      state.evalDatasets.status = "error";
      state.evalDatasets.error = error.message;
    }
    render();
  });
  document.querySelectorAll("[data-select-eval-dataset]").forEach(button => button.addEventListener("click", async () => {
    if (button.dataset.selectEvalDataset === state.evalDatasets.selectedId) return;
    state.evalDatasets.selectedId = button.dataset.selectEvalDataset;
    state.evalDatasets.tab = button.dataset.selectEvalDataset === "feedback-golden" ? "candidates" : "items";
    state.evalDatasets.lifecycleStatus = "active";
    state.evalDatasets.query = "";
    state.evalDatasets.status = "loading";
    render();
    try {
      await hydrateEvalDatasetSelection();
      state.evalDatasets.status = "ready";
    } catch (error) {
      state.evalDatasets.status = "error";
      state.evalDatasets.error = error.message;
    }
    render();
  }));
  document.querySelectorAll("[data-eval-tab]").forEach(button => button.addEventListener("click", () => {
    state.evalDatasets.tab = button.dataset.evalTab;
    state.evalDatasets.query = "";
    render();
  }));
  document.querySelector("[data-eval-lifecycle]")?.addEventListener("change", async event => {
    state.evalDatasets.lifecycleStatus = event.currentTarget.value;
    state.evalDatasets.status = "loading";
    render();
    try {
      await hydrateEvalDatasetSelection();
      state.evalDatasets.status = "ready";
    } catch (error) {
      state.evalDatasets.status = "error";
      state.evalDatasets.error = error.message;
    }
    render();
  });
  document.querySelector("[data-eval-item-search]")?.addEventListener("input", event => filterEvalDatasetRows(event.currentTarget.value));
  document.querySelector("[data-export-eval-dataset]")?.addEventListener("click", downloadEvalDatasetJsonl);
  document.querySelectorAll("[data-golden-lifecycle]").forEach(button => button.addEventListener("click", async () => {
    const card = button.closest("[data-golden-item]");
    const viewport = captureEvalDatasetViewport({ removingElement: card });
    button.disabled = true;
    try {
      await updateGoldenSetLifecycle(card.dataset.goldenItem, button.dataset.goldenLifecycle);
      toast(button.dataset.goldenLifecycle === "archive" ? "Dataset item archived" : "Dataset item restored");
      await hydrateEvalDatasets({ viewport });
    } catch (error) {
      toast(`Lifecycle update failed: ${error.message}`);
      button.disabled = false;
    }
  }));
  document.querySelectorAll("[data-golden-candidate]").forEach(card => {
    const evidenceDetails = card.querySelector("[data-evidence-details]");
    evidenceDetails?.addEventListener("toggle", async () => {
      if (!evidenceDetails.open || evidenceDetails.dataset.loaded === "true") return;
      const panel = evidenceDetails.querySelector("[data-evidence-panel]");
      if (panel) panel.innerHTML = `<div class="golden-evidence-loading">Loading the immutable evidence snapshot…</div>`;
      try {
        const payload = await fetchFeedbackEvidence(card.dataset.goldenCandidate);
        if (panel) panel.innerHTML = renderEvaluationEvidence(payload.evidence);
        evidenceDetails.dataset.loaded = "true";
      } catch (error) {
        if (panel) panel.innerHTML = `<div class="golden-evidence-empty">${escapeHtml(error.message)}</div>`;
      }
    });
    const submitReview = async decision => {
      const viewport = captureEvalDatasetViewport({ removingElement: card });
      const buttons = card.querySelectorAll("button");
      buttons.forEach(button => { button.disabled = true; });
      try {
        const expectedOutput = card.querySelector("[data-expected-output]")?.value.trim() || undefined;
        const failureCodes = (card.querySelector("[data-failure-codes]")?.value || "").split(",").map(value => value.trim()).filter(Boolean);
        await reviewFeedbackCandidate(card.dataset.goldenCandidate, {
          decision,
          expectedOutput,
          expectedRoute: expectedRoutePayload(card),
          failureCodes
        });
        toast(decision === "approve" ? "Added to the Active Dataset" : "Candidate removed from the review inbox");
        await hydrateEvalDatasets({ viewport });
      } catch (error) {
        toast(`Review failed: ${error.message}`);
        buttons.forEach(button => { button.disabled = false; });
      }
    };
    card.querySelector("[data-review-approve]")?.addEventListener("click", () => void submitReview("approve"));
    card.querySelector("[data-review-reject]")?.addEventListener("click", () => void submitReview("reject"));
  });
}

let evalRunRefreshTimer = null;

const evalRunStatusLabels = Object.freeze({
  draft: "Draft",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled"
});

function evalRunProfile(profileId) {
  return state.evalRuns.payload?.configuration?.profiles?.find(profile => profile.id === profileId) || null;
}

function defaultEvalRunName(profileId = "local", now = new Date()) {
  const profileName = evalRunProfile(profileId)?.name || (profileId === "ci" ? "CI" : profileId.split("-").map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(" "));
  const pad = value => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${profileName} evaluation · ${timestamp}`;
}

function evalRunProfileSignals(profile) {
  if (!profile) return [];
  return [
    profile.mode === "live" ? "Real models & tools" : "Offline scripted",
    profile.traces ? "Langfuse Trace on" : "Trace off",
    profile.judge ? `Judge · ${profile.judge_model || "configured model"}` : "Judge off",
    Number.isFinite(profile.minimum_cases) ? `Minimum ${profile.minimum_cases} cases` : null
  ].filter(Boolean);
}

function renderEvalRunProfileGuide(profiles, selectedId) {
  return `<details class="eval-run-profile-guide">
    <summary><span>Profile guide</span><small>Execution, observability, and scoring policy</small>${icon("down")}</summary>
    <div>${profiles.map(profile => `<article class="${profile.id === selectedId ? "selected" : ""}">
      <div><strong>${escapeHtml(profile.name)}</strong><p>${escapeHtml(profile.description || "Configured evaluation policy")}</p></div>
      <span>${evalRunProfileSignals(profile).map(signal => `<em>${escapeHtml(signal)}</em>`).join("")}</span>
    </article>`).join("")}</div>
  </details>`;
}

function evalRunDate(value) {
  if (!value) return "Not started";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function evalRunElapsed(run) {
  if (!run?.started_at) return "Not started";
  const end = run.ended_at ? new Date(run.ended_at).getTime() : Date.now();
  const start = new Date(run.started_at).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? formatRuntimeDuration(Math.max(0, end - start)) : "Unavailable";
}

function captureEvalRunViewport() {
  const scroller = document.querySelector(".eval-runs-scroll");
  return scroller ? { top: Number(scroller.scrollTop || 0) } : null;
}

function restoreEvalRunViewport(viewport) {
  if (!viewport) return;
  requestAnimationFrame(() => {
    if (state.currentView !== "eval-runs") return;
    const scroller = document.querySelector(".eval-runs-scroll");
    if (scroller) scroller.scrollTop = viewport.top;
  });
}

function scheduleEvalRunRefresh() {
  if (evalRunRefreshTimer) clearTimeout(evalRunRefreshTimer);
  evalRunRefreshTimer = null;
  if (state.currentView !== "eval-runs") return;
  const active = (state.evalRuns.payload?.runs || []).some(run => ["queued", "running"].includes(run.execution_status));
  if (!active) return;
  evalRunRefreshTimer = setTimeout(() => void hydrateEvalRuns({ quiet: true }), 1600);
}

function defaultEvalRunDatasets(payload) {
  return (payload?.configuration?.datasets || []).filter(dataset => dataset.source === "built-in" && dataset.available).map(dataset => dataset.id);
}

async function hydrateEvalRuns({ quiet = false, viewport = captureEvalRunViewport() } = {}) {
  if (!quiet) state.evalRuns.status = "loading";
  state.evalRuns.error = null;
  if (!quiet) render({ evalRunViewport: viewport });
  try {
    const payload = await fetchEvalRuns(state.evalRuns.lifecycle);
    state.evalRuns.payload = payload;
    if (!state.evalRuns.draft.datasetIds.length) state.evalRuns.draft.datasetIds = defaultEvalRunDatasets(payload);
    const known = payload.runs.some(run => run.id === state.evalRuns.selectedId);
    if (!known) state.evalRuns.selectedId = payload.runs[0]?.id || null;
    state.evalRuns.selectedRun = state.evalRuns.selectedId
      ? (await fetchEvalRun(state.evalRuns.selectedId)).run
      : null;
    state.evalRuns.status = "ready";
  } catch (error) {
    state.evalRuns.status = "error";
    state.evalRuns.error = error.message;
  }
  render({ evalRunViewport: viewport });
  scheduleEvalRunRefresh();
}

async function openEvalRuns() {
  state.currentView = "eval-runs";
  state.sidebarOpen = false;
  history.replaceState({}, "", "#eval-runs");
  render();
  if (state.evalRuns.status === "idle" || state.evalRuns.status === "error") await hydrateEvalRuns();
  else scheduleEvalRunRefresh();
}

function renderEvalRunBadge(run) {
  const status = run.execution_status || "draft";
  const gate = run.gate_status === "failed" ? " · Gate failed" : run.gate_status === "passed" ? " · Gate passed" : "";
  return `<span class="eval-run-badge ${escapeHtml(status)} ${escapeHtml(run.gate_status || "pending")}">${escapeHtml(evalRunStatusLabels[status] || status)}${gate}</span>`;
}

function renderEvalRunRow(run) {
  const summary = run.summary || {};
  return `<button class="eval-run-row ${state.evalRuns.selectedId === run.id ? "active" : ""}" data-select-eval-run="${escapeHtml(run.id)}">
    <span class="eval-run-row-state ${escapeHtml(run.execution_status)}"></span>
    <span class="eval-run-row-copy"><strong>${escapeHtml(run.name)}</strong><small>${escapeHtml(run.profile)} · ${summary.cases ?? "—"} cases · ${escapeHtml(evalRunDate(run.updated_at))}</small></span>
    ${renderEvalRunBadge(run)}
  </button>`;
}

function renderEvalRunComposer() {
  if (!state.evalRuns.composerOpen) return "";
  const profiles = state.evalRuns.payload?.configuration?.profiles || [];
  const datasets = state.evalRuns.payload?.configuration?.datasets || [];
  const selected = new Set(state.evalRuns.draft.datasetIds);
  const profile = evalRunProfile(state.evalRuns.draft.profile);
  return `<section class="eval-run-composer" aria-label="Create Eval Run">
    <header><div><span>New evaluation</span><h2>Define a reproducible run</h2><p>Freeze a Dataset scope and execute it with one configured Eval Profile.</p></div><button data-close-eval-run-composer aria-label="Close new Eval Run">${icon("close")}</button></header>
    <form data-eval-run-form>
      <label class="eval-run-field"><span>Run name</span><input name="name" maxlength="120" placeholder="e.g. Routing regression · release 3.1" value="${escapeHtml(state.evalRuns.draft.name)}" required /></label>
      <label class="eval-run-field"><span>Eval Profile</span><select name="profile" data-eval-run-profile>${profiles.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === state.evalRuns.draft.profile ? "selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(evalRunProfileSignals(item).slice(0, 3).join(" · "))}</option>`).join("")}</select><small>${escapeHtml(profile?.description || "Configured evaluation policy")}</small></label>
      ${renderEvalRunProfileGuide(profiles, state.evalRuns.draft.profile)}
      <details class="eval-run-dataset-picker" open><summary><span>Dataset scope</span><small>${selected.size} selected</small>${icon("down")}</summary><div>${datasets.map(dataset => `<label class="${dataset.available ? "" : "disabled"}"><input type="checkbox" name="dataset" value="${escapeHtml(dataset.id)}" ${selected.has(dataset.id) ? "checked" : ""} ${dataset.available ? "" : "disabled"} /><span><strong>${escapeHtml(dataset.name)}</strong><small>${escapeHtml(dataset.version)} · ${dataset.item_count} active cases</small></span><em>${escapeHtml(dataset.dimension.replaceAll("_", " "))}</em></label>`).join("")}</div></details>
      ${profile?.requires_confirmation ? `<label class="eval-run-confirm"><input type="checkbox" name="confirmLive" /><span>I understand this run calls live models or tools and may consume credits.</span></label>` : ""}
      <footer><button type="button" class="eval-secondary-action" data-save-eval-run>Save draft</button><button type="submit" class="eval-export">${icon("activity")} Create & run</button></footer>
    </form>
  </section>`;
}

function evalRunLifecycleStep(run, id) {
  const order = ["draft", "queued", "running", "result"];
  const terminal = TERMINAL_EVAL_RUN_STATUSES.has(run.execution_status);
  const position = run.execution_status === "draft" ? 0 : run.execution_status === "queued" ? 1 : run.execution_status === "running" ? 2 : 3;
  const index = order.indexOf(id);
  const stateClass = index < position ? "complete" : index === position ? (id === "result" && run.execution_status !== "completed" ? run.execution_status : "current") : "pending";
  const labels = { draft: "Defined", queued: "Queued", running: "Running", result: terminal ? evalRunStatusLabels[run.execution_status] : "Result" };
  return `<span class="${stateClass}"><i>${index < position || (id === "result" && run.execution_status === "completed") ? icon("check") : index + 1}</i><strong>${escapeHtml(labels[id])}</strong></span>`;
}

const TERMINAL_EVAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function renderEvalRunActions(run) {
  const live = evalRunProfile(run.profile)?.requires_confirmation;
  const confirm = live ? "true" : "false";
  const actions = [];
  if (run.lifecycle_status === "archived") {
    actions.push(`<button class="eval-secondary-action" data-eval-run-action="restore">Restore</button>`);
  } else if (run.execution_status === "draft") {
    actions.push(`<button class="eval-export" data-eval-run-action="start" data-confirm-live="${confirm}">${icon("activity")} Run now</button>`);
    actions.push(`<button class="eval-secondary-action" data-eval-run-action="archive">Archive</button>`);
  } else if (["queued", "running"].includes(run.execution_status)) {
    actions.push(`<button class="eval-run-danger" data-eval-run-action="cancel">${icon("stop")} Cancel</button>`);
  } else {
    actions.push(`<button class="eval-export" data-eval-run-action="rerun" data-confirm-live="${confirm}">${icon("retry")} Run again</button>`);
    actions.push(`<button class="eval-secondary-action" data-eval-run-action="archive">Archive</button>`);
  }
  return actions.join("");
}

function renderEvalRunResult(run) {
  if (run.execution_status === "draft") return `<div class="eval-run-empty-detail"><strong>Ready to run</strong><span>This Draft freezes ${run.dataset_ids.length} Dataset${run.dataset_ids.length === 1 ? "" : "s"}. Start it when the scope is ready.</span></div>`;
  if (["queued", "running"].includes(run.execution_status)) return `<div class="eval-run-progress"><i></i><strong>${run.execution_status === "queued" ? "Waiting for the Eval Runner" : "Evaluating the selected Dataset snapshot"}</strong><span>The page refreshes this Run automatically while execution continues.</span></div>`;
  if (run.execution_status === "failed" && !Object.keys(run.summary || {}).length) return `<div class="eval-run-empty-detail failure"><strong>Evaluation infrastructure failed</strong><span>${escapeHtml(run.error_message || "Inspect the runner log for details.")}</span></div>`;
  if (run.execution_status === "cancelled") return `<div class="eval-run-empty-detail"><strong>Run cancelled</strong><span>No gate decision was produced. Rerun the same immutable scope when ready.</span></div>`;
  const checks = run.summary?.checks || {};
  const failures = run.result?.failed_checks || [];
  const suites = Object.entries(run.summary?.bySuite || {});
  return `<div class="eval-run-results">
    <div class="eval-run-metrics">
      <span class="${run.gate_status === "passed" ? "pass" : "fail"}"><small>Release gate</small><strong>${run.gate_status === "passed" ? "Passed" : "Failed"}</strong></span>
      <span><small>Cases</small><strong>${run.summary?.cases ?? 0}</strong></span>
      <span><small>Checks passed</small><strong>${checks.passed ?? 0}<em> / ${checks.total ?? 0}</em></strong></span>
      <span><small>Blocking failures</small><strong>${checks.blockingFailures ?? 0}</strong></span>
      <span><small>Diagnostic failures</small><strong>${checks.diagnosticFailures ?? 0}</strong></span>
    </div>
    ${suites.length ? `<section class="eval-run-suite-table"><header><strong>Suite results</strong><small>${suites.length} slices</small></header><div>${suites.map(([name, value]) => `<span><strong>${escapeHtml(name)}</strong><small>${value.cases} cases</small><em class="${value.blockingFailures ? "fail" : "pass"}">${value.blockingFailures ? `${value.blockingFailures} blocking` : "Passed"}</em></span>`).join("")}</div></section>` : ""}
    <section class="eval-run-failures"><header><strong>Failure analysis</strong><small>${failures.length ? `${failures.length} signals require review` : "No failed evaluator signals"}</small></header>${failures.length ? `<div>${failures.map(item => `<article><span class="${escapeHtml(item.severity || "diagnostic")}">${escapeHtml(item.severity || "diagnostic")}</span><div><strong>${escapeHtml(item.evaluator || "Evaluator")}</strong><small>${escapeHtml(item.scopeId || "Run")}</small><p>${escapeHtml(item.reason || "No reason recorded")}</p></div></article>`).join("")}</div>` : `<div class="eval-run-pass-note">${icon("check")} Every configured check passed for this Dataset snapshot.</div>`}</section>
  </div>`;
}

function renderEvalRunDetail() {
  const run = state.evalRuns.selectedRun;
  if (!run) return `<section class="eval-run-detail"><div class="eval-empty"><strong>No Eval Runs yet</strong><span>Create a Draft to define the Dataset scope, then run it when ready.</span></div></section>`;
  const profile = evalRunProfile(run.profile);
  return `<section class="eval-run-detail">
    <header class="eval-run-detail-head"><div><span>Evaluation run</span><h2>${escapeHtml(run.name)}</h2><p>${escapeHtml(profile?.description || "Configured evaluation run")}</p></div><div class="eval-run-detail-actions">${renderEvalRunBadge(run)}<div>${renderEvalRunActions(run)}</div></div><div class="eval-detail-facts"><span><strong>${escapeHtml(profile?.name || run.profile)}</strong><small>Profile</small></span><span><strong>${run.dataset_ids.length}</strong><small>Datasets</small></span><span><strong>${escapeHtml(evalRunElapsed(run))}</strong><small>Duration</small></span><span><strong>${escapeHtml(evalRunDate(run.created_at))}</strong><small>Created</small></span></div></header>
    <div class="eval-run-lifecycle" aria-label="Eval Run lifecycle">${["draft", "queued", "running", "result"].map(id => evalRunLifecycleStep(run, id)).join("")}</div>
    <div class="eval-run-scope"><div><strong>Frozen Dataset scope</strong><small>${run.dataset_ids.map(id => escapeHtml(id)).join(" · ")}</small></div>${run.parent_run_id ? `<span>Rerun of <code>${escapeHtml(run.parent_run_id)}</code></span>` : `<span>Original run</span>`}</div>
    ${renderEvalRunResult(run)}
    ${run.log ? `<details class="eval-run-log"><summary><span>Runner log</span><small>Debug output · credentials redacted</small>${icon("down")}</summary><pre>${escapeHtml(run.log)}</pre></details>` : ""}
  </section>`;
}

function renderEvalRunsPage() {
  if (state.evalRuns.status === "loading" && !state.evalRuns.payload) return `<main class="workspace eval-workspace"><div class="eval-page-loading"><i></i><strong>Loading Eval Runs</strong><span>Resolving user-scoped execution history and configured profiles.</span></div></main>`;
  if (state.evalRuns.status === "error" && !state.evalRuns.payload) return `<main class="workspace eval-workspace"><div class="eval-page-loading error"><strong>Could not load Eval Runs</strong><span>${escapeHtml(state.evalRuns.error || "Unknown error")}</span><button data-retry-eval-runs>Retry</button></div></main>`;
  const payload = state.evalRuns.payload || { runs: [], summary: {} };
  const summary = payload.summary || {};
  return `<main class="workspace eval-workspace eval-runs-workspace">
    <header class="conversation-header section-page-header"><div class="section-page-title"><button class="mobile-menu" data-mobile-open aria-label="Open sidebar">${icon("menu")}</button><span class="section-page-mark">${icon("activity")}</span><div><h1>Eval Runs</h1><p>Define, execute, inspect, rerun, and archive reproducible evaluations</p></div></div><div class="eval-header-summary"><span><strong>${summary.total || 0}</strong> runs</span><i></i><span><strong>${summary.active || 0}</strong> active</span><i></i><span><strong>${summary.passed || 0}</strong> passed</span><i></i><span class="${summary.attention ? "needs-review" : ""}"><strong>${summary.attention || 0}</strong> attention</span></div></header>
    <div class="eval-runs-scroll"><div class="section-page-content">
      <div class="eval-runs-toolbar"><div><button class="eval-export" data-new-eval-run>${icon("plus")} New Eval Run</button><select data-eval-run-lifecycle aria-label="Filter Eval Runs"><option value="active" ${state.evalRuns.lifecycle === "active" ? "selected" : ""}>Active runs</option><option value="archived" ${state.evalRuns.lifecycle === "archived" ? "selected" : ""}>Archived runs</option><option value="all" ${state.evalRuns.lifecycle === "all" ? "selected" : ""}>All runs</option></select></div></div>
      ${renderEvalRunComposer()}
      <div class="eval-runs-layout"><aside class="eval-run-list"><header><strong>Run history</strong><small>${payload.runs.length}</small></header><div>${payload.runs.length ? payload.runs.map(renderEvalRunRow).join("") : `<div class="eval-catalog-empty">No ${escapeHtml(state.evalRuns.lifecycle)} Eval Runs</div>`}</div></aside>${renderEvalRunDetail()}</div>
    </div></div>
  </main>`;
}

function readEvalRunForm(start) {
  const form = document.querySelector("[data-eval-run-form]");
  if (!form) return null;
  const profile = form.elements.profile.value;
  const profileConfig = evalRunProfile(profile);
  const confirmLive = Boolean(form.elements.confirmLive?.checked);
  if (start && profileConfig?.requires_confirmation && !confirmLive) {
    toast("Confirm live model and tool usage before starting this Run");
    return null;
  }
  return {
    name: form.elements.name.value.trim(),
    profile,
    datasetIds: [...form.querySelectorAll('input[name="dataset"]:checked')].map(input => input.value),
    start,
    confirmLive
  };
}

async function submitEvalRun(start, button) {
  const payload = readEvalRunForm(start);
  if (!payload) return;
  button.disabled = true;
  try {
    const response = await createEvalRun(payload);
    state.evalRuns.selectedId = response.run.id;
    state.evalRuns.composerOpen = false;
    state.evalRuns.draft = { name: "", profile: "local", datasetIds: defaultEvalRunDatasets(state.evalRuns.payload), automaticName: true };
    toast(start ? "Eval Run started" : "Eval Run saved as Draft");
    await hydrateEvalRuns();
  } catch (error) {
    toast(`Could not create Eval Run: ${error.message}`);
    button.disabled = false;
  }
}

async function performEvalRunAction(run, action, button) {
  let confirmLive = false;
  if (["start", "rerun"].includes(action) && evalRunProfile(run.profile)?.requires_confirmation) {
    confirmLive = confirm("This evaluation calls live models or tools and may consume credits. Continue?");
    if (!confirmLive) return;
  }
  button.disabled = true;
  try {
    const response = await updateEvalRun(run.id, action, { confirmLive });
    if (action === "rerun") {
      state.evalRuns.lifecycle = "active";
      state.evalRuns.selectedId = response.run.id;
    }
    if (action === "restore") {
      state.evalRuns.lifecycle = "active";
      state.evalRuns.selectedId = response.run.id;
    }
    toast(action === "start" ? "Eval Run started" : action === "cancel" ? "Eval Run cancelled" : action === "rerun" ? "Eval Run restarted from the same scope" : action === "archive" ? "Eval Run archived" : "Eval Run restored");
    await hydrateEvalRuns();
  } catch (error) {
    toast(`Eval Run update failed: ${error.message}`);
    button.disabled = false;
  }
}

function bindEvalRunEvents() {
  document.querySelector("[data-retry-eval-runs]")?.addEventListener("click", () => void hydrateEvalRuns());
  document.querySelector("[data-new-eval-run]")?.addEventListener("click", () => {
    state.evalRuns.composerOpen = true;
    if (!state.evalRuns.draft.name || state.evalRuns.draft.automaticName) {
      state.evalRuns.draft.name = defaultEvalRunName(state.evalRuns.draft.profile);
      state.evalRuns.draft.automaticName = true;
    }
    render();
    requestAnimationFrame(() => document.querySelector('[data-eval-run-form] input[name="name"]')?.focus());
  });
  document.querySelector("[data-close-eval-run-composer]")?.addEventListener("click", () => {
    state.evalRuns.composerOpen = false;
    render();
  });
  document.querySelector("[data-eval-run-profile]")?.addEventListener("change", event => {
    state.evalRuns.draft.datasetIds = [...document.querySelectorAll('[data-eval-run-form] input[name="dataset"]:checked')].map(input => input.value);
    state.evalRuns.draft.profile = event.currentTarget.value;
    if (state.evalRuns.draft.automaticName) state.evalRuns.draft.name = defaultEvalRunName(state.evalRuns.draft.profile);
    render();
  });
  document.querySelector('[data-eval-run-form] input[name="name"]')?.addEventListener("input", event => {
    state.evalRuns.draft.name = event.currentTarget.value;
    state.evalRuns.draft.automaticName = false;
  });
  document.querySelector("[data-eval-run-form]")?.addEventListener("submit", event => {
    event.preventDefault();
    void submitEvalRun(true, event.currentTarget.querySelector('[type="submit"]'));
  });
  document.querySelector("[data-save-eval-run]")?.addEventListener("click", event => void submitEvalRun(false, event.currentTarget));
  document.querySelector("[data-eval-run-lifecycle]")?.addEventListener("change", async event => {
    state.evalRuns.lifecycle = event.currentTarget.value;
    state.evalRuns.selectedId = null;
    await hydrateEvalRuns();
  });
  document.querySelectorAll("[data-select-eval-run]").forEach(button => button.addEventListener("click", async () => {
    if (button.dataset.selectEvalRun === state.evalRuns.selectedId) return;
    state.evalRuns.selectedId = button.dataset.selectEvalRun;
    state.evalRuns.selectedRun = null;
    render();
    try {
      state.evalRuns.selectedRun = (await fetchEvalRun(state.evalRuns.selectedId)).run;
    } catch (error) {
      toast(`Could not load Eval Run: ${error.message}`);
    }
    render();
  }));
  document.querySelectorAll("[data-eval-run-action]").forEach(button => button.addEventListener("click", () => {
    if (state.evalRuns.selectedRun) void performEvalRunAction(state.evalRuns.selectedRun, button.dataset.evalRunAction, button);
  }));
}

function renderMain() {
  if (state.currentView === "eval-runs") return renderEvalRunsPage();
  if (state.currentView === "eval-datasets") return renderEvalDatasetPage();
  if (state.currentView === "memory") return renderMemoryPage();
  const conversation = findConversation(state.activeId);
  const hasMessages = Boolean(conversation?.prompt);
  return `<main class="workspace ${hasMessages ? "chat-active" : "home-active"}">
    ${hasMessages ? renderConversation(conversation) : `<header class="mobile-home-header"><button data-mobile-open>${icon("menu")}</button><span>${productMark("small")} Personal Copilot</span><button data-new-chat>${icon("compose")}</button></header>${renderHome()}`}
  </main>`;
}

function render({
  evalViewport = state.currentView === "eval-datasets" ? captureEvalDatasetViewport() : null,
  evalRunViewport = state.currentView === "eval-runs" ? captureEvalRunViewport() : null
} = {}) {
  if (state.auth.status !== "authenticated") {
    app.innerHTML = renderAuthScreen();
    modalRoot.innerHTML = "";
    bindAuthEvents();
    return;
  }
  const conversation = findConversation(state.activeId);
  app.innerHTML = `<div class="application-shell">${renderSidebar()}${renderMain()}${state.currentView === "chat" ? renderRuntimeInspector(conversation?.prompt ? conversation : null) : ""}</div>`;
  bindEvents();
  if (state.currentView === "eval-datasets") restoreEvalDatasetViewport(evalViewport);
  if (state.currentView === "eval-runs") restoreEvalRunViewport(evalRunViewport);
  if (state.currentView === "chat") {
    requestAnimationFrame(() => document.querySelector("[data-message-scroll]")?.scrollTo({ top: 99999 }));
    hydrateObservedRuntime(conversation);
  }
}

function bindEvents() {
  document.querySelectorAll("[data-open-chat]").forEach(button => button.addEventListener("click", () => openChat(button.dataset.openChat)));
  document.querySelectorAll("[data-delete-session]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    void deleteConversationFromUi(button.dataset.deleteSession);
  }));
  document.querySelectorAll("[data-new-chat]").forEach(button => button.addEventListener("click", newChat));
  document.querySelectorAll("[data-mobile-open]").forEach(button => button.addEventListener("click", () => { state.sidebarOpen = true; render(); }));
  document.querySelectorAll("[data-mobile-close]").forEach(button => button.addEventListener("click", () => { state.sidebarOpen = false; render(); }));
  document.querySelector("[data-collapse]")?.addEventListener("click", () => { state.sidebarCollapsed = !state.sidebarCollapsed; render(); });
  document.querySelector("[data-search]")?.addEventListener("click", showSearch);
  document.querySelector("[data-account-menu]")?.addEventListener("click", showAccountMenu);
  document.querySelector("[data-memory-manager]")?.addEventListener("click", () => void openMemoryPage());
  document.querySelector("[data-eval-datasets]")?.addEventListener("click", () => void openEvalDatasets());
  document.querySelector("[data-eval-runs]")?.addEventListener("click", () => void openEvalRuns());
  bindMemoryPageEvents();
  bindEvalDatasetEvents();
  bindEvalRunEvents();
  document.querySelectorAll("[data-model-picker]").forEach(button => button.addEventListener("click", showModelPicker));
  document.querySelectorAll("[data-attachments]").forEach(button => button.addEventListener("click", showAttachments));
  document.querySelectorAll("[data-file-input]").forEach(input => input.addEventListener("change", event => {
    const files = [...(event.currentTarget.files || [])];
    if (files.length) void handleFileUpload(files);
  }));
  document.querySelectorAll("[data-toast]").forEach(button => button.addEventListener("click", () => toast(button.dataset.toast)));
  document.querySelector("[data-share]")?.addEventListener("click", async () => {
    await writeClipboard(location.href);
    toast("Conversation link copied");
  });
  document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => applyQuickAction(button.dataset.action)));
  document.querySelectorAll("[data-tool-toggle]").forEach(button => button.addEventListener("click", () => button.classList.toggle("expanded")));
  document.querySelector("[data-runtime-toggle]")?.addEventListener("click", () => { state.inspectorOpen = !state.inspectorOpen; render(); });
  document.querySelectorAll("[data-runtime-close]").forEach(button => button.addEventListener("click", () => { state.inspectorOpen = false; render(); }));
  document.querySelectorAll("[data-trace-toggle]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.traceToggle;
    const traceElement = button.closest("[data-session-trace]");
    const expanded = traceElement.classList.toggle("expanded");
    traceElement.classList.toggle("collapsed", !expanded);
    state.expandedTraces = expanded ? [...new Set([...state.expandedTraces, id])] : state.expandedTraces.filter(value => value !== id);
  }));
  document.querySelectorAll("[data-copy-trace]").forEach(button => button.addEventListener("click", async event => { event.stopPropagation(); await navigator.clipboard?.writeText(event.currentTarget.innerText.trim()); toast("Trace ID copied"); }));
  document.querySelector("[data-copy-session]")?.addEventListener("click", async event => { await navigator.clipboard?.writeText(event.currentTarget.innerText.trim()); toast("Session ID copied"); });
  document.querySelectorAll("[data-span-toggle]").forEach(button => button.addEventListener("click", event => toggleSpanElement(event.currentTarget)));
  bindTraceCodeCopy();
  bindDagNodes();
  document.querySelectorAll("[data-copy-answer]").forEach(button => button.addEventListener("click", async () => { await navigator.clipboard?.writeText(button.closest(".assistant-body")?.querySelector(".markdown-body")?.innerText || ""); toast("Copied to clipboard"); }));
  document.querySelectorAll("[data-feedback]").forEach(button => button.addEventListener("click", async () => {
    const requestId = button.dataset.feedbackRequest;
    if (!requestId || button.disabled) return;
    const group = button.closest(".message-actions");
    group?.querySelectorAll("[data-feedback]").forEach(item => { item.disabled = true; });
    try {
      await submitFeedback({ requestId, value: Number(button.dataset.feedback) });
      group?.querySelectorAll("[data-feedback]").forEach(item => item.classList.toggle("selected", item === button));
      toast("Feedback and evaluation evidence saved");
    } catch (error) {
      toast(`Could not save feedback: ${error.message}`);
    } finally {
      group?.querySelectorAll("[data-feedback]").forEach(item => { item.disabled = false; });
    }
  }));
  document.querySelectorAll("[data-remove-artifact]").forEach(button => button.addEventListener("click", () => {
    state.selectedArtifacts = state.selectedArtifacts.filter(item => item.artifact_id !== button.dataset.removeArtifact);
    render();
  }));

  document.querySelectorAll("[data-composer]").forEach(form => {
    const textarea = form.querySelector("textarea");
    const send = form.querySelector(".send-control");
    const sync = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
      send.disabled = (!textarea.value.trim() && !state.selectedArtifacts.length) || state.streaming || state.uploadingArtifacts.length > 0;
    };
    textarea.addEventListener("input", sync);
    textarea.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if ((!textarea.value.trim() && !state.selectedArtifacts.length) || state.streaming || state.uploadingArtifacts.length) return;
      submitPrompt(textarea.value.trim() || "Analyze the selected attachments.");
    });
    sync();
  });
}

function openChat(id) {
  persistActiveConversation();
  state.pendingController?.abort();
  state.pendingController = null;
  state.chatEpoch += 1;
  state.activeId = id;
  state.currentView = "chat";
  const conversation = findConversation(id);
  if (!conversation) return;
  state.generated = Array.isArray(conversation.generated) ? [...conversation.generated] : [];
  state.pendingPrompt = "";
  state.sidebarOpen = false;
  state.inspectorOpen = Boolean(conversation.prompt);
  state.runtimeCursor = null;
  state.streaming = false;
  state.selectedArtifacts = [];
  const traces = sessionTraces(conversation);
  state.expandedTraces = traces.length ? [traces.at(-1).clientId] : [];
  state.activeTraceClientId = traces.at(-1)?.clientId || null;
  state.sessionId = conversation?.sessionId || `copilot-${id}`;
  conversation.sessionId = state.sessionId;
  state.model = findModel(conversation.modelId || conversation.model);
  history.replaceState({}, "", `#chat/${id}`);
  render();
  if (!conversation.prompt) requestAnimationFrame(() => document.querySelector("textarea")?.focus());
}

async function deleteConversationFromUi(id) {
  const conversation = findConversation(id);
  if (!conversation) return;
  const confirmed = globalThis.confirm?.(`Delete “${conversation.title}”? This removes the local session, turns, and feedback candidates. Long-term memory and exported traces are not affected.`) ?? true;
  if (!confirmed) return;
  const active = state.activeId === id;
  if (active) state.pendingController?.abort();
  try {
    if (conversation.serverBacked || conversation.prompt || sessionTraces(conversation).some(trace => trace.requestId)) {
      await deleteSession(conversation.sessionId);
    }
  } catch (error) {
    if (error.status !== 404) {
      toast(`Could not delete conversation: ${error.message}`);
      return;
    }
  }
  savedConversations = savedConversations.filter(item => item.id !== id);
  persistConversationCache();
  if (!active) {
    render();
    toast("Conversation deleted");
    return;
  }
  state.pendingController = null;
  state.streaming = false;
  const next = savedConversations[0] || null;
  if (next) openChat(next.id);
  else newChat();
  toast("Conversation deleted");
}

function newChat() {
  persistActiveConversation();
  state.pendingController?.abort();
  state.pendingController = null;
  state.chatEpoch += 1;
  const createdAt = new Date().toISOString();
  const sessionId = createSessionId();
  const conversation = {
    id: `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sessionId,
    title: "New conversation",
    group: "Today",
    prompt: "",
    answer: "",
    model: state.model.name,
    modelId: state.model.id,
    agent: null,
    tool: null,
    traceId: null,
    generated: [],
    runtime: [],
    traces: [],
    status: "draft",
    serverBacked: false,
    createdAt,
    updatedAt: createdAt
  };
  saveConversation(conversation);
  state.activeId = conversation.id;
  state.currentView = "chat";
  state.generated = [];
  state.pendingPrompt = "";
  state.sidebarOpen = false;
  state.inspectorOpen = false;
  state.runtimeCursor = null;
  state.streaming = false;
  state.selectedArtifacts = [];
  state.expandedTraces = [];
  state.activeTraceClientId = null;
  state.sessionId = sessionId;
  history.replaceState({}, "", `#chat/${conversation.id}`);
  closeModal();
  render();
  requestAnimationFrame(() => document.querySelector("textarea")?.focus());
}

function createSessionId() {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `copilot-${suffix}`;
}

async function submitPrompt(prompt) {
  let conversation = findConversation(state.activeId);
  if (!conversation) {
    const createdAt = new Date().toISOString();
    conversation = {
      id: `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      sessionId: state.sessionId || createSessionId(),
      title: "New conversation",
      group: "Today",
      prompt: "",
      answer: "",
      model: state.model.name,
      modelId: state.model.id,
      generated: [],
      runtime: [],
      traces: [],
      status: "draft",
      serverBacked: false,
      createdAt,
      updatedAt: createdAt
    };
    saveConversation(conversation);
    state.activeId = conversation.id;
    state.sessionId = conversation.sessionId;
    history.replaceState({}, "", `#chat/${conversation.id}`);
  }
  const firstTurn = !conversation.prompt;
  const responseModel = state.model;
  const submittedArtifacts = [...state.selectedArtifacts];
  if (firstTurn) {
    Object.assign(conversation, {
      title: titleFromPrompt(prompt),
      prompt,
      answer: "",
      agent: null,
      tool: null,
      model: responseModel.name,
      modelId: responseModel.id,
      attachments: submittedArtifacts,
      status: "active"
    });
    state.generated = [];
    state.sessionId ||= createSessionId();
    conversation.sessionId = state.sessionId;
    saveConversation(conversation);
  } else if (!state.sessionId) {
    state.sessionId = conversation.sessionId || `copilot-${state.activeId}`;
  }

  conversation.sessionId = state.sessionId;
  const trace = {
    clientId: traceClientId(),
    traceId: null,
    turn: sessionTraces(conversation).length + 1,
    prompt,
    answer: "",
    specialist: null,
    intent: null,
    model: responseModel.name,
    modelId: responseModel.id,
    inputArtifacts: submittedArtifacts,
    tool: null,
    runtime: [],
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    requestId: null
  };
  sessionTraces(conversation).push(trace);
  const requestEpoch = state.chatEpoch + 1;
  state.chatEpoch = requestEpoch;
  state.pendingController?.abort();
  const controller = new AbortController();
  state.pendingController = controller;
  state.streaming = true;
  state.pendingPrompt = firstTurn ? "" : prompt;
  state.inspectorOpen = true;
  state.runtimeCursor = null;
  state.expandedTraces = [trace.clientId];
  state.activeTraceClientId = trace.clientId;
  state.expandedSpans = [];
  conversation.status = "active";
  saveConversation(conversation);
  render();

  try {
    const payload = await streamChat({
      prompt,
      sessionId: conversation.sessionId,
      requestId: trace.clientId,
      model: responseModel.id,
      artifactNames: submittedArtifacts.map(item => item.artifact_id),
      signal: controller.signal,
      onMessage: message => {
        if (requestEpoch !== state.chatEpoch || state.activeId !== conversation.id) return;
        if (message.type === "trace") {
          trace.traceId = message.traceId;
          conversation.traceId = message.traceId;
          syncLiveTraceIdentity(trace);
        } else if (message.type === "span" && message.event?.id) {
          upsertRuntimeSpan(conversation, trace, message.event);
        }
      }
    });
    if (requestEpoch !== state.chatEpoch || state.activeId !== conversation.id) return;

    state.sessionId = payload.sessionId;
    conversation.sessionId = payload.sessionId;
    conversation.serverBacked = true;
    conversation.traceId = payload.traceId;
    conversation.requestId = payload.requestId;
    conversation.agent = payload.specialist;
    conversation.tool = payload.tool;
    conversation.runtime = payload.runtime || [];
    trace.traceId = payload.traceId;
    trace.requestId = payload.requestId;
    trace.answer = payload.answer;
    trace.specialist = payload.specialist;
    trace.intent = payload.intent || null;
    trace.model = payload.modelDisplayName || responseModel.name;
    trace.modelId = payload.model || responseModel.id;
    trace.inputArtifacts = payload.inputArtifacts || submittedArtifacts;
    trace.tool = payload.tool;
    trace.runtime = payload.runtime || trace.runtime;
    trace.status = "completed";
    trace.completedAt = new Date().toISOString();
    observedRuntime.set(payload.traceId, payload.runtime || []);
    if (firstTurn) {
      conversation.answer = payload.answer;
      conversation.model = payload.modelDisplayName || responseModel.name;
      conversation.modelId = payload.model || responseModel.id;
      conversation.attachments = payload.inputArtifacts || submittedArtifacts;
    }
    else state.generated.push({
      prompt,
      answer: payload.answer,
      requestId: payload.requestId,
      traceId: payload.traceId,
      specialist: payload.specialist,
      model: payload.modelDisplayName || responseModel.name,
      modelId: payload.model || responseModel.id,
      inputArtifacts: payload.inputArtifacts || submittedArtifacts,
      tool: payload.tool,
      artifacts: payload.artifacts,
      runtime: payload.runtime,
      intent: payload.intent,
      startedAt: trace.startedAt,
      completedAt: trace.completedAt
    });
    conversation.generated = [...state.generated];
    conversation.status = "completed";
    saveConversation(conversation);
    state.streaming = false;
    state.pendingPrompt = "";
    state.selectedArtifacts = [];
    state.runtimeCursor = null;
    render();
  } catch (error) {
    if (requestEpoch !== state.chatEpoch || error.name === "AbortError") return;
    state.streaming = false;
    const answer = `Personal Copilot could not complete this request: ${error.message}`;
    if (firstTurn) conversation.answer = answer;
    else state.generated.push({ prompt, answer });
    conversation.generated = [...state.generated];
    conversation.status = "error";
    trace.answer = answer;
    trace.status = "error";
    trace.completedAt = new Date().toISOString();
    saveConversation(conversation);
    state.pendingPrompt = "";
    state.runtimeCursor = null;
    render();
    toast("Request failed. Check the server logs for details.");
  } finally {
    if (requestEpoch === state.chatEpoch) state.pendingController = null;
  }
}

function showModelPicker() {
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close-modal><div class="model-popover" role="dialog" aria-label="Select response model">
    <div class="popover-title"><div><strong>Select response model</strong><span>Use automatic routing or pin a specific model for the next turn.</span></div><button data-close-modal>${icon("close")}</button></div>
    <div class="model-search">${icon("search")}<input placeholder="Search by model, provider, or use case" autofocus /></div>
    <div class="model-list">${models.map(model => `<button data-select-model="${model.id}">${modelMark(model.mark)}<span><strong>${escapeHtml(model.name)}</strong><small><b>${escapeHtml(model.provider)}</b> · ${escapeHtml(model.sub)}</small><em>${escapeHtml((model.modalities || []).join(" · "))}</em></span>${state.model.id === model.id ? icon("check") : ""}</button>`).join("")}</div>
    <div class="popover-footer"><span>${models.length} available options</span><span>The intent model is configured separately</span></div>
  </div></div>`;
  keepModalOpenOnSurface(".model-popover");
  modalRoot.querySelectorAll("[data-close-modal]").forEach(button => button.addEventListener("click", closeModal));
  modalRoot.querySelectorAll("[data-select-model]").forEach(button => button.addEventListener("click", () => {
    state.model = models.find(model => model.id === button.dataset.selectModel);
    closeModal(); render();
  }));
  modalRoot.querySelector("input")?.addEventListener("input", event => {
    modalRoot.querySelectorAll("[data-select-model]").forEach(button => button.hidden = !button.innerText.toLowerCase().includes(event.target.value.toLowerCase()));
  });
}

function showSearch() {
  const catalog = allConversations();
  modalRoot.innerHTML = `<div class="modal-backdrop search-backdrop" data-close-modal><div class="search-dialog" role="dialog">
    <div class="global-search">${icon("search")}<input placeholder="Search your chats" autofocus/><kbd>esc</kbd></div>
    <div class="search-results"><span>Recent chats</span>${catalog.map(item => `<button data-result="${item.id}">${icon("chat")}<span><strong>${escapeHtml(item.title)}</strong><small>${conversationGroup(item)}</small></span>${icon("chevron")}</button>`).join("")}</div>
  </div></div>`;
  keepModalOpenOnSurface(".search-dialog");
  modalRoot.querySelector("[data-close-modal]").addEventListener("click", closeModal);
  modalRoot.querySelectorAll("[data-result]").forEach(button => button.addEventListener("click", () => { closeModal(); openChat(button.dataset.result); }));
  const input = modalRoot.querySelector("input");
  input.addEventListener("input", () => modalRoot.querySelectorAll("[data-result]").forEach(row => row.hidden = !row.innerText.toLowerCase().includes(input.value.toLowerCase())));
  requestAnimationFrame(() => input.focus());
}

async function showAttachments(event) {
  const button = event.currentTarget;
  const rect = button.getBoundingClientRect();
  const viewportHeight = globalThis.innerHeight || globalThis.window?.innerHeight || 800;
  modalRoot.innerHTML = `<div class="clear-layer" data-close-modal><div class="attachment-menu" style="left:${Math.max(16, rect.left)}px;bottom:${Math.max(88, viewportHeight - rect.top + 8)}px"><div class="artifact-loading">Loading artifacts…</div></div></div>`;
  keepModalOpenOnSurface(".attachment-menu");
  modalRoot.querySelector("[data-close-modal]").addEventListener("click", closeModal);
  try {
    const payload = await fetchArtifacts();
    const artifacts = payload.artifacts || [];
    const selected = new Set(state.selectedArtifacts.map(item => item.artifact_id));
    const menu = modalRoot.querySelector(".attachment-menu");
    if (!menu) return;
    menu.innerHTML = `<div class="artifact-menu-title"><strong>Add attachments</strong><small>Images, PDFs, text, and audio are sent as real multimodal input. Maximum file size: 20 MB.</small></div>
      <button class="upload-device" data-upload-device>${icon("plus")}<span><strong>Upload from device</strong><small>Supports PDF, PNG, JPEG, WebP, TXT, MD, JSON, CSV, MP3, and WAV</small></span></button>
      <div class="artifact-menu-divider"><span>Your files</span></div>
      ${artifacts.length
        ? artifacts.map(item => `<button data-select-artifact="${escapeHtml(item.artifact_id)}" class="${selected.has(item.artifact_id) ? "selected" : ""}">${icon(item.mime_type?.startsWith("image/") ? "image" : "file")}<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.file_name)} · ${formatBytes(item.size_bytes)}</small></span>${selected.has(item.artifact_id) ? icon("check") : ""}</button>`).join("")
        : `<div class="artifact-empty"><strong>No uploaded files</strong><small>Files uploaded from your device are saved in your workspace.</small></div>`}`;
    menu.querySelector("[data-upload-device]")?.addEventListener("click", () => {
      const input = document.querySelector("[data-file-input]");
      closeModal();
      input?.click();
    });
    menu.querySelectorAll("[data-select-artifact]").forEach(item => item.addEventListener("click", () => {
      const artifact = artifacts.find(candidate => candidate.artifact_id === item.dataset.selectArtifact);
      if (!artifact) return;
      state.selectedArtifacts = selected.has(artifact.artifact_id)
        ? state.selectedArtifacts.filter(candidate => candidate.artifact_id !== artifact.artifact_id)
        : [...state.selectedArtifacts, artifact].slice(0, 10);
      closeModal();
      render();
    }));
  } catch (error) {
    const menu = modalRoot.querySelector(".attachment-menu");
    if (menu) menu.innerHTML = `<div class="artifact-empty"><strong>Could not load files</strong><small>${escapeHtml(error.message)}</small></div>`;
  }
}

async function handleFileUpload(files) {
  const capacity = Math.max(0, 10 - state.selectedArtifacts.length - state.uploadingArtifacts.length);
  const accepted = files.slice(0, capacity);
  if (!accepted.length) {
    toast("You can select up to 10 attachments per turn");
    return;
  }
  state.sessionId ||= findConversation(state.activeId)?.sessionId || createSessionId();
  const uploads = accepted.map(file => ({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name }));
  state.uploadingArtifacts = [...state.uploadingArtifacts, ...uploads];
  render();
  await Promise.all(accepted.map(async (file, index) => {
    const uploadState = uploads[index];
    try {
      const payload = await uploadArtifact(file, state.sessionId);
      if (!state.selectedArtifacts.some(item => item.artifact_id === payload.artifact.artifact_id)) {
        state.selectedArtifacts = [...state.selectedArtifacts, payload.artifact].slice(0, 10);
      }
    } catch (error) {
      toast(`Could not upload ${file.name}: ${error.message}`);
    } finally {
      state.uploadingArtifacts = state.uploadingArtifacts.filter(item => item.id !== uploadState.id);
      render();
    }
  }));
  if (accepted.length < files.length) toast("Some files were not uploaded: the limit is 10 attachments per turn");
}

async function showSetupWizard({ firstLogin = false, payload = null } = {}) {
  modalRoot.innerHTML = `<div class="modal-backdrop setup-backdrop"><section class="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title"><div class="artifact-loading">Loading core configuration…</div></section></div>`;
  keepModalOpenOnSurface(".setup-dialog");
  try {
    const initial = payload || await fetchSetupState();
    state.setup = initial;
    renderSetupWizard(initial);
  } catch (error) {
    const dialog = modalRoot.querySelector(".setup-dialog");
    if (dialog) dialog.innerHTML = `<div class="setup-fatal"><strong>Could not load core configuration</strong><p>${escapeHtml(error.message)}</p><button class="secondary-button" data-close-setup>Back</button></div>`;
    dialog?.querySelector("[data-close-setup]")?.addEventListener("click", closeModal);
  }

  function renderSetupWizard(setup, verification = null) {
    const dialog = modalRoot.querySelector(".setup-dialog");
    if (!dialog) return;
    const canManage = Boolean(setup.administration?.canManage);
    const gatewayReady = Boolean(setup.modelGateway?.configured);
    const searchReady = Boolean(setup.search?.configured);
    const judgeReady = Boolean(setup.evaluationJudge?.configured);
    const tracingConfigured = Boolean(setup.tracing?.configured);
    const tracingActive = Boolean(setup.tracing?.active);
    const completed = Boolean(setup.onboarding?.completed);
    const sourceLabel = setup.modelGateway?.apiKeySource === "web-runtime"
      ? "Web runtime"
      : setup.modelGateway?.apiKeySource === "environment"
        ? "Server environment"
        : "Not configured";
    const searchSourceLabel = setup.search?.apiKeySource === "web-runtime"
      ? "Web runtime"
      : setup.search?.apiKeySource === "environment"
        ? "Server environment"
        : "Not configured";
    const judgeSourceLabel = setup.evaluationJudge?.modelSource === "web-runtime"
      ? "Web runtime"
      : setup.evaluationJudge?.modelSource === "environment"
        ? "Server environment"
        : "System preset";
    dialog.innerHTML = `
      <header class="setup-head">
        <div class="setup-brand">${productMark("headline")}<span><small>${firstLogin ? "FIRST-RUN SETUP" : "CORE CONFIGURATION"}</small><strong id="setup-title">${verification ? "Configuration verified" : "Complete core configuration"}</strong></span></div>
        <button class="icon-button" data-close-setup aria-label="Close configuration wizard">${icon("close")}</button>
      </header>
      ${verification ? `
        <div class="setup-success">
          <span class="setup-success-mark">${icon("check")}</span>
          <div><strong>Personal Copilot is ready</strong><p>The live model probe succeeded with <code>${escapeHtml(verification.model)}</code> in ${Number(verification.latencyMs || 0)} ms. LLM-as-a-Judge is configured as <code>${escapeHtml(setup.evaluationJudge?.model || "Not configured")}</code>.${tracingConfigured && !tracingActive ? " Langfuse configuration is saved and will begin exporting after a restart." : tracingActive ? " Langfuse traces are being exported." : ""}</p></div>
        </div>
        <div class="setup-actions setup-success-actions"><button class="primary-button" data-close-setup>Start using Personal Copilot</button></div>
      ` : `
        <div class="setup-intro">
          <p>Review the current model, evaluation, Search, and Langfuse settings. Secrets stay on the server and never enter the browser, sessions, or traces.</p>
          <span class="setup-progress"><i class="${gatewayReady ? "done" : ""}"></i><i class="${searchReady ? "done" : ""}"></i><i class="${judgeReady ? "done" : ""}"></i><i class="${tracingConfigured ? "done" : ""}"></i></span>
        </div>
        <div class="setup-body">
          <aside class="setup-summary">
            <div class="setup-summary-item active"><span>01</span><div><strong>Model gateway</strong><small>${gatewayReady ? "Credential detected" : "Configuration required"}</small></div><em class="status-dot ${gatewayReady ? "ready" : "missing"}"></em></div>
            <div class="setup-summary-item"><span>02</span><div><strong>Search and routing</strong><small>${searchReady ? "Independent connection configured" : "Search API Key required"}</small></div><em class="status-dot ${searchReady ? "ready" : "pending"}"></em></div>
            <div class="setup-summary-item"><span>03</span><div><strong>Evaluation judge</strong><small>${judgeSourceLabel} · ${setup.evaluationJudge?.model || "Not configured"}</small></div><em class="status-dot ${judgeReady ? "ready" : "missing"}"></em></div>
            <div class="setup-summary-item"><span>04</span><div><strong>Langfuse tracing</strong><small>${tracingActive ? "Exporting" : tracingConfigured ? "Saved; restart required" : "Optional"}</small></div><em class="status-dot ${tracingActive ? "ready" : "pending"}"></em></div>
            <div class="setup-owner-note">${canManage
              ? "You can manage core configuration for this instance. The first user to save becomes the configuration administrator."
              : setup.administration?.ownerClaimed
                ? "Another local administrator manages instance configuration. You can still verify it and complete your own setup."
                : "This deployment disables configuration changes from the Web UI. Ask the deployment administrator to set the environment variables."}</div>
          </aside>
          <form class="setup-form" data-setup-form>
            <section class="setup-current-config" aria-label="Current configuration">
              <header><span>Current configuration</span><small>Non-sensitive values and credential status currently active on this instance</small></header>
              <div>
                <article><span>LLM gateway</span><strong title="${escapeHtml(setup.modelGateway?.baseUrl || "Not configured")}">${escapeHtml(setup.modelGateway?.baseUrl || "Not configured")}</strong><small>API Key · ${escapeHtml(sourceLabel)}</small></article>
                <article><span>Intent model</span><strong title="${escapeHtml(setup.modelGateway?.intentionModel || "Not configured")}">${escapeHtml(setup.modelGateway?.intentionModel || "Not configured")}</strong><small>Intent routing only</small></article>
                <article><span>LLM-as-a-Judge</span><strong title="${escapeHtml(setup.evaluationJudge?.model || "Not configured")}">${escapeHtml(setup.evaluationJudge?.model || "Not configured")}</strong><small>${escapeHtml(judgeSourceLabel)} · preset ${escapeHtml(setup.evaluationJudge?.systemDefaultModel || "Not configured")}</small></article>
                <article><span>Search</span><strong title="${escapeHtml(setup.search?.baseUrl || "Not configured")}">${escapeHtml(setup.search?.baseUrl || "Not configured")}</strong><small>API Key · ${escapeHtml(searchSourceLabel)}</small></article>
                <article><span>Langfuse</span><strong title="${escapeHtml(setup.tracing?.baseUrl || "Not configured")}">${escapeHtml(setup.tracing?.baseUrl || "Not configured")}</strong><small>${escapeHtml(setup.tracing?.environment || "development")} · ${tracingConfigured ? "Credentials configured" : "No credentials"}</small></article>
              </div>
            </section>
            <section class="setup-section">
              <div class="setup-section-title"><span>Required</span><div><strong>LLM Gateway</strong><small>Used for Intent, Direct, and Specialist Generation</small></div><b>${gatewayReady ? "Configured" : "Not configured"}</b></div>
              <div class="setup-grid">
                <label class="setup-field full"><span>API Key <em>· ${escapeHtml(sourceLabel)}</em></span><input name="llmApiKey" type="password" autocomplete="new-password" spellcheck="false" ${canManage ? "" : "disabled"} ${gatewayReady ? "" : "required"} placeholder="${gatewayReady ? "Configured; leave blank to keep it" : "Enter a server-side API Key"}" /><small>Saved keys are never displayed again.</small></label>
                <label class="setup-field full"><span>Base URL</span><input name="llmBaseUrl" type="url" value="${escapeHtml(setup.modelGateway?.baseUrl || "")}" ${canManage ? "" : "disabled"} required /></label>
                <label class="setup-field full"><span>Intent model</span><input name="intentionModel" value="${escapeHtml(setup.modelGateway?.intentionModel || "google/gemini-3.1-flash-lite")}" ${canManage ? "" : "disabled"} required /><small>Used only for intent detection. Response models are selected by Model Router or explicitly by the user.</small></label>
              </div>
            </section>
            <section class="setup-section judge-setup-section">
              <div class="setup-section-title"><span>Evaluation</span><div><strong>LLM-as-a-Judge</strong><small>Used only by live semantic evaluation; independent from application Model routing</small></div><b>${judgeSourceLabel}</b></div>
              <div class="setup-grid">
                <label class="setup-field full"><span>Judge model</span><input name="judgeModel" value="${escapeHtml(setup.evaluationJudge?.model || setup.evaluationJudge?.systemDefaultModel || "")}" ${canManage ? "" : "disabled"} required /><small>System preset: <code>${escapeHtml(setup.evaluationJudge?.systemDefaultModel || "Not configured")}</code>. The Judge reuses the configured LLM Gateway endpoint and credential.</small></label>
              </div>
            </section>
            <section class="setup-section compact">
              <div class="setup-section-title"><span>Tool</span><div><strong>Search</strong><small>Independent Tavily-compatible endpoint and credential</small></div><b>${searchReady ? "Configured" : "Not configured"}</b></div>
              <div class="setup-grid">
                <label class="setup-field full"><span>Base URL</span><input name="searchBaseUrl" type="url" value="${escapeHtml(setup.search?.baseUrl || "https://search.onerouter.pro/v1/tavily")}" ${canManage ? "" : "disabled"} required /></label>
                <label class="setup-field full"><span>API Key <em>· ${escapeHtml(searchSourceLabel)}</em></span><input name="searchApiKey" type="password" autocomplete="new-password" spellcheck="false" ${canManage ? "" : "disabled"} placeholder="${setup.search?.apiKeyConfigured ? "Configured; leave blank to keep it" : "Enter the Search API Key"}" /><small>The key is never displayed after saving. It remains a separate setting even when it has the same value as the model gateway key.</small></label>
              </div>
            </section>
            <section class="setup-section langfuse-setup-section">
              <div class="setup-section-title"><span>Recommended</span><div><strong>Langfuse observability</strong><small>Instrumentation is preloaded; save credentials and restart to export traces</small></div><b>${tracingActive ? "Running" : tracingConfigured ? "Restart required" : "Not configured"}</b></div>
              <div class="setup-grid">
                <label class="setup-field full"><span>Langfuse Base URL</span><input name="langfuseBaseUrl" type="url" value="${escapeHtml(setup.tracing?.baseUrl || "https://cloud.langfuse.com")}" ${canManage ? "" : "disabled"} required /><small>Defaults to the official Langfuse EU Cloud. You can use another region or a self-hosted endpoint.</small></label>
                <label class="setup-field"><span>Public Key</span><input name="langfusePublicKey" type="password" autocomplete="new-password" spellcheck="false" ${canManage ? "" : "disabled"} placeholder="${setup.tracing?.publicKeyConfigured ? "Configured; leave blank to keep it" : "pk-lf-..."}" /></label>
                <label class="setup-field"><span>Secret Key</span><input name="langfuseSecretKey" type="password" autocomplete="new-password" spellcheck="false" ${canManage ? "" : "disabled"} placeholder="${setup.tracing?.secretKeyConfigured ? "Configured; leave blank to keep it" : "sk-lf-..."}" /></label>
                <label class="setup-field"><span>Environment</span><input name="langfuseEnvironment" value="${escapeHtml(setup.tracing?.environment || "development")}" ${canManage ? "" : "disabled"} required /></label>
                <div class="trace-config-row"><span>${icon("activity")}</span><div><strong>${tracingActive ? "Trace export active" : tracingConfigured ? "Configuration saved securely" : "Waiting for Langfuse credentials"}</strong><small>${escapeHtml(setup.tracing?.destination || "https://cloud.langfuse.com")}</small></div><em>${tracingActive ? "Running" : tracingConfigured ? "Restart to apply" : "Not connected"}</em></div>
              </div>
            </section>
            <div class="setup-message" data-setup-message>${completed ? "This user has completed setup before. Saving will verify the current configuration again." : "Verification sends one live model request capped at 8 tokens."}</div>
            <div class="setup-actions">
              <button type="button" class="secondary-button" data-close-setup>${firstLogin ? "Configure later" : "Cancel"}</button>
              <button type="submit" class="primary-button" ${!canManage && !gatewayReady ? "disabled" : ""}>${canManage ? "Save and verify" : "Verify and continue"}</button>
            </div>
          </form>
        </div>
      `}
    `;
    dialog.querySelectorAll("[data-close-setup]").forEach(button => button.addEventListener("click", closeModal));
    const form = dialog.querySelector("[data-setup-form]");
    form?.addEventListener("submit", async event => {
      event.preventDefault();
      const submit = form.querySelector("button[type='submit']");
      const message = form.querySelector("[data-setup-message]");
      submit.disabled = true;
      message.className = "setup-message working";
      message.textContent = canManage ? "Saving securely and verifying the model connection…" : "Verifying the model connection…";
      try {
        if (canManage) {
          const values = new FormData(form);
          await updateCoreConfiguration({
            llmApiKey: values.get("llmApiKey"),
            llmBaseUrl: values.get("llmBaseUrl"),
            intentionModel: values.get("intentionModel"),
            judgeModel: values.get("judgeModel"),
            searchBaseUrl: values.get("searchBaseUrl"),
            searchApiKey: values.get("searchApiKey"),
            langfuseBaseUrl: values.get("langfuseBaseUrl"),
            langfusePublicKey: values.get("langfusePublicKey"),
            langfuseSecretKey: values.get("langfuseSecretKey"),
            langfuseEnvironment: values.get("langfuseEnvironment")
          });
        }
        const result = await completeCoreSetup();
        state.setup = result.setup;
        renderSetupWizard(result.setup, result.verification);
      } catch (error) {
        message.className = "setup-message error";
        message.textContent = error.message;
        submit.disabled = false;
      }
    });
  }
}

async function showAccountMenu() {
  modalRoot.innerHTML = `<div class="clear-layer" data-close-modal><div class="account-menu"><div class="artifact-loading">Loading memory settings…</div></div></div>`;
  keepModalOpenOnSurface(".account-menu");
  modalRoot.querySelector("[data-close-modal]").addEventListener("click", closeModal);
  try {
    const payload = await fetchMemories();
    const menu = modalRoot.querySelector(".account-menu");
    if (!menu) return;
    menu.innerHTML = `<div class="account-menu-head"><span class="avatar">${escapeHtml(avatarText())}<i></i></span><span><strong>${escapeHtml(state.auth.user?.username || "Local user")}</strong><small>${payload.memories.length} long-term ${payload.memories.length === 1 ? "memory" : "memories"}</small></span></div>
      <button data-toggle-memory>${icon("bulb")}<span>${payload.settings.enabled ? "Disable long-term memory" : "Enable long-term memory"}</span></button>
      <button data-manage-memory>${icon("file")}<span>Manage long-term memory</span></button>
      <button data-core-setup>${icon("sliders")}<span>Core configuration</span></button>
      <button data-logout>${icon("close")}<span>Sign out</span></button>`;
    menu.querySelector("[data-toggle-memory]").addEventListener("click", async () => {
      await setMemoryEnabled(!payload.settings.enabled);
      closeModal();
      toast(payload.settings.enabled ? "Long-term memory disabled" : "Long-term memory enabled");
    });
    menu.querySelector("[data-manage-memory]").addEventListener("click", () => void openMemoryPage(payload));
    menu.querySelector("[data-core-setup]").addEventListener("click", () => void showSetupWizard());
    menu.querySelector("[data-logout]").addEventListener("click", () => void signOut());
  } catch (error) {
    const menu = modalRoot.querySelector(".account-menu");
    if (menu) menu.innerHTML = `<div class="artifact-empty"><strong>Could not load account settings</strong><small>${escapeHtml(error.message)}</small></div>`;
  }
}

function expectedRoutePayload(card) {
  const mode = card.querySelector("[data-expected-mode]")?.value || "";
  const agentId = card.querySelector("[data-expected-agent]")?.value.trim() || null;
  if (!mode) return undefined;
  return { mode, agentId: mode === "delegate" ? agentId : null };
}

function evidenceSummaryMarkup(item) {
  const evidence = item.evaluation_evidence;
  if (!evidence) {
    return `<div class="golden-evidence-status legacy"><strong>Evidence unavailable</strong><span>This legacy candidate predates point-in-time Trace capture.</span></div>`;
  }
  return `<div class="golden-evidence-status">
      <span><strong>Target Trace</strong>${Number(evidence.trace_span_count || 0)} spans</span>
      <span><strong>Session prefix</strong>${Number(evidence.session_turn_count || 0)} turns · ${Number(evidence.session_span_count || 0)} spans</span>
      <span><strong>Boundary</strong>Through turn ${Number(evidence.target_turn_index || 0)} · no future turns</span>
    </div>
    <details class="golden-evidence-inspector" data-evidence-details>
      <summary>Inspect point-in-time Trace &amp; Session evidence</summary>
      <div class="golden-evidence-panel" data-evidence-panel><div class="golden-evidence-loading">Open to load the server-authoritative snapshot.</div></div>
    </details>`;
}

function prettyEvidence(value) {
  if (value === undefined || value === null) return "Not captured";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function renderEvaluationEvidence(evidence) {
  const snapshot = evidence?.snapshot || {};
  const subject = snapshot.subject || {};
  const session = snapshot.session || {};
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const runtime = Array.isArray(snapshot.trace?.trace?.runtime) ? snapshot.trace.trace.runtime : [];
  return `<div class="golden-evidence-meta">
      <span><strong>Snapshot</strong>${escapeHtml(evidence.id || "Unknown")}</span>
      <span><strong>Schema</strong>${escapeHtml(evidence.schema_version || snapshot.schemaVersion || "Unknown")}</span>
      <span><strong>Captured</strong>${escapeHtml(evidence.captured_at || snapshot.capturedAt || "Unknown")}</span>
      <span><strong>SHA-256</strong><code>${escapeHtml(String(evidence.content_hash || snapshot.contentHash || "").slice(0, 16))}…</code></span>
    </div>
    <section class="golden-evidence-section">
      <header><strong>Session through evaluated turn</strong><span>${turns.length} turns · future turns excluded</span></header>
      <div class="golden-session-turns">${turns.map(turn => {
        const target = turn.requestId === subject.requestId;
        return `<article class="golden-session-turn${target ? " target" : ""}">
          <header><span>Turn ${String(turn.turnIndex || 0).padStart(2, "0")}</span>${target ? "<em>Feedback target</em>" : ""}<code>${escapeHtml(turn.traceId || "No Trace ID")}</code></header>
          <div><strong>User</strong><p>${escapeHtml(turn.input?.content || "")}</p></div>
          <div><strong>Assistant</strong><p>${escapeHtml(turn.output?.content || "")}</p></div>
        </article>`;
      }).join("")}</div>
    </section>
    <section class="golden-evidence-section">
      <header><strong>Target Trace runtime</strong><span>${runtime.length} complete local spans</span></header>
      <div class="golden-trace-spans">${runtime.length ? runtime.map((span, index) => `<details>
        <summary><span>${String(index + 1).padStart(2, "0")}</span><code>${escapeHtml(span.kind || "SPAN")}</code><strong>${escapeHtml(span.name || span.id || "Unnamed span")}</strong><em class="${escapeHtml(span.status || "completed")}">${escapeHtml(span.status || "completed")}</em></summary>
        <div class="golden-span-detail"><p>${escapeHtml(span.summary || "No summary captured.")}</p>
          <label>Input<pre>${escapeHtml(prettyEvidence(span.input))}</pre></label>
          <label>Output<pre>${escapeHtml(prettyEvidence(span.output))}</pre></label>
          <label>Metadata<pre>${escapeHtml(prettyEvidence(span.metadata || {}))}</pre></label>
        </div>
      </details>`).join("") : `<div class="golden-evidence-empty">This Trace contains no local runtime spans.</div>`}</div>
    </section>`;
}

function applyQuickAction(action) {
  const prompts = {
    research: "Research this topic in depth and cite reliable sources: ",
    analyze: "Analyze the selected documents and extract the key conclusions: ",
    document: "Create a well-structured PDF report about: ",
    code: "Build or debug the following code: ",
    explain: "Explain this concept in plain language: "
  };
  const textarea = document.querySelector(".hero-composer textarea");
  if (!textarea) return;
  textarea.value = prompts[action];
  textarea.dispatchEvent(new Event("input"));
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function keepModalOpenOnSurface(selector) {
  modalRoot.querySelector(selector)?.addEventListener("click", event => event.stopPropagation());
}

function closeModal() { modalRoot.innerHTML = ""; }

function toast(message) {
  const root = document.querySelector("#toast-root");
  const item = document.createElement("div");
  item.className = "toast";
  item.innerHTML = `${icon("check")}<span>${escapeHtml(message)}</span>`;
  root.append(item);
  requestAnimationFrame(() => item.classList.add("shown"));
  setTimeout(() => { item.classList.remove("shown"); setTimeout(() => item.remove(), 220); }, 1900);
}

function titleFromPrompt(text) {
  return text.trim().split(/\s+/).slice(0, 6).join(" ").replace(/^./, c => c.toUpperCase());
}

function markForModel(name) {
  return models.find(model => model.name === name)?.mark || "copilot";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function markdown(value = "") {
  let html = escapeHtml(value);
  const codeBlocks = [];
  html = html.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, language, code) => {
    codeBlocks.push(`<div class="code-block"><div><span>${language || "text"}</span><button data-toast="Code copied">${icon("copy")} Copy</button></div><pre><code>${code.trim()}</code></pre></div>`);
    return `@@CODE${codeBlocks.length - 1}@@`;
  });
  const tables = [];
  html = html.replace(/((?:^|\n)\|.+\|\n\|[-: |]+\|(?:\n\|.+\|)+)/g, table => {
    const rows = table.trim().split("\n").filter((_, index) => index !== 1).map(row => row.split("|").slice(1, -1).map(cell => cell.trim()));
    const [head, ...body] = rows;
    tables.push(`<div class="table-wrap"><table><thead><tr>${head.map(cell => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${body.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    return `\n@@TABLE${tables.length - 1}@@\n`;
  });
  html = html
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^(?:- |\* )(.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)(?=\n(?!<li>)|$)/g, "<ul>$1</ul>")
    .replace(/<\/li>\n<li>/g, "</li><li>")
    .split(/\n{2,}/).map(block => /^<(h\d|ul|div|@@)/.test(block) || /^@@/.test(block) ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`).join("");
  html = html.replace(/@@CODE(\d+)@@/g, (_, index) => codeBlocks[index]).replace(/@@TABLE(\d+)@@/g, (_, index) => tables[index]);
  return html;
}

window.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
  if (state.auth.status === "authenticated" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    newChat();
  }
});

render();
void bootstrapAuth();
