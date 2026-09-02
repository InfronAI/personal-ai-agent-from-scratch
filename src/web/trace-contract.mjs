export function upsertRuntimeEvent(events, candidate) {
  const list = Array.isArray(events) ? events : [];
  const index = list.findIndex(item => item.id === candidate.id);
  if (index >= 0) list[index] = { ...list[index], ...candidate };
  else list.push(candidate);
  return list;
}

function eventOrder(left, right) {
  return (Number(left.sequence) || 0) - (Number(right.sequence) || 0)
    || (Number(left.sourceIndex) || 0) - (Number(right.sourceIndex) || 0)
    || String(left.id || "").localeCompare(String(right.id || ""));
}

function createsParentCycle(event, byId) {
  const visited = new Set([event.id]);
  let parentId = event.parentId;
  while (parentId && byId.has(parentId)) {
    if (visited.has(parentId)) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

/**
 * 只依据 parentId 生成展示树，避免后端传入的 depth 与真实父子关系不一致。
 * 缺失父节点、自引用或环路节点会被安全提升为根节点，保证观测面板始终可渲染。
 */
export function traceEventForest(events) {
  const source = (Array.isArray(events) ? events : [])
    .filter(event => event?.id)
    .sort(eventOrder);
  const byId = new Map(source.map(event => [event.id, event]));
  const children = new Map();
  const roots = [];

  for (const event of source) {
    const hasUsableParent = event.parentId
      && event.parentId !== event.id
      && byId.has(event.parentId)
      && !createsParentCycle(event, byId);
    if (!hasUsableParent) {
      roots.push(event);
      continue;
    }
    const bucket = children.get(event.parentId) || [];
    bucket.push(event);
    children.set(event.parentId, bucket);
  }

  const buildNode = (event, depth) => {
    const childNodes = (children.get(event.id) || []).sort(eventOrder).map(child => buildNode(child, depth + 1));
    return {
      event: { ...event, depth },
      depth,
      children: childNodes,
      descendantCount: childNodes.reduce((total, child) => total + child.descendantCount + 1, 0)
    };
  };
  return roots.sort(eventOrder).map(event => buildNode(event, 0));
}

export function orderedTraceEvents(events) {
  const result = [];
  const append = node => {
    result.push(node.event);
    for (const child of node.children) append(child);
  };
  for (const root of traceEventForest(events)) append(root);
  return result;
}

export function traceContractErrors(events) {
  const source = Array.isArray(events) ? events : [];
  const ids = new Set(source.filter(event => event?.id).map(event => event.id));
  const byId = new Map(source.filter(event => event?.id).map(event => [event.id, event]));
  const errors = [];
  const seen = new Set();
  for (const event of source) {
    if (!event.id) errors.push("Runtime event is missing an id");
    else if (seen.has(event.id)) errors.push(`${event.id} has a duplicate id`);
    else seen.add(event.id);
    if (event.parentId === event.id) errors.push(`${event.id} cannot reference itself`);
    if (event.parentId && !ids.has(event.parentId)) errors.push(`${event.id} references a missing parent`);
    if (event.id && createsParentCycle(event, byId)) errors.push(`${event.id} contains a cycle in its parent chain`);
    if (event.schemaVersion && event.schemaVersion !== "copilot-runtime-event.v1") errors.push(`${event.id} uses an unsupported schema version`);
  }
  return errors;
}
