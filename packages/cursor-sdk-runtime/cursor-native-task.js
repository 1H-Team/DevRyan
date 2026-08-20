export const CURSOR_NATIVE_TASK_METADATA_KEY = 'cursorNativeTask';
export const CURSOR_NATIVE_TASK_SCHEMA_VERSION = 1;

const MAX_TEXT_CHARS = 8000;
const MAX_ENTRIES = 24;

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const sameValue = (left, right) => {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const appendBoundedText = (previous, incoming) => {
  const current = typeof previous === 'string' ? previous : '';
  const next = typeof incoming === 'string' ? incoming : '';
  if (!next) return current;
  const merged = next.startsWith(current) ? next : `${current}${next}`;
  if (merged.length <= MAX_TEXT_CHARS) return merged;
  return `…${merged.slice(-(MAX_TEXT_CHARS - 1))}`;
};

const normalizeStoredProjection = (value, parentCallId, modelCallId) => {
  const record = isPlainObject(value) ? value : {};
  return {
    schemaVersion: CURSOR_NATIVE_TASK_SCHEMA_VERSION,
    source: 'cursor-native',
    parentCallId: trimString(record.parentCallId) || trimString(parentCallId),
    modelCallId: trimString(record.modelCallId) || trimString(modelCallId),
    text: typeof record.text === 'string' ? record.text : '',
    entries: Array.isArray(record.entries) ? record.entries.slice(-MAX_ENTRIES) : [],
    stepCount: typeof record.stepCount === 'number' && Number.isFinite(record.stepCount)
      ? Math.max(0, Math.floor(record.stepCount))
      : 0,
    currentStep: typeof record.currentStep === 'number' && Number.isFinite(record.currentStep)
      ? Math.max(0, Math.floor(record.currentStep))
      : undefined,
    thinking: record.thinking === true,
    truncated: record.truncated === true,
  };
};

const mergeToolEntry = (projection, update) => {
  const entryID = trimString(update.call_id);
  if (!entryID) return projection;
  const existingIndex = projection.entries.findIndex((entry) => entry?.id === entryID);
  const existing = existingIndex >= 0 && isPlainObject(projection.entries[existingIndex])
    ? projection.entries[existingIndex]
    : {};
  const existingState = isPlainObject(existing.state) ? existing.state : {};
  const nextState = {
    ...existingState,
    status: trimString(update.status) || trimString(existingState.status) || 'running',
    ...(isPlainObject(update.args) ? { input: update.args } : {}),
    ...(update.result !== undefined ? { output: update.result } : {}),
  };
  const nextEntry = {
    id: entryID,
    tool: trimString(update.name) || trimString(existing.tool) || 'tool',
    state: nextState,
  };
  if (existingIndex >= 0 && sameValue(existing, nextEntry)) return projection;

  let entries;
  let truncated = projection.truncated;
  if (existingIndex >= 0) {
    entries = projection.entries.slice();
    entries[existingIndex] = nextEntry;
  } else {
    entries = [...projection.entries, nextEntry];
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(-MAX_ENTRIES);
      truncated = true;
    }
  }
  return { ...projection, entries, truncated };
};

export const mergeCursorNativeTaskActivity = (stored, message) => {
  const parentCallId = trimString(message?.call_id);
  const update = isPlainObject(message?.update) ? message.update : null;
  if (!parentCallId || !update) return stored ?? null;

  const projection = normalizeStoredProjection(stored, parentCallId, message?.model_call_id);
  if (update.type === 'text-delta') {
    const text = appendBoundedText(projection.text, update.text);
    return text === projection.text ? projection : { ...projection, text };
  }
  if (update.type === 'thinking-delta') {
    return projection.thinking ? projection : { ...projection, thinking: true };
  }
  if (update.type === 'thinking-completed') {
    return projection.thinking ? { ...projection, thinking: false } : projection;
  }
  if (update.type === 'tool-call') {
    return mergeToolEntry(projection, update);
  }
  if (update.type === 'step-started') {
    const step = Number(update.step_id);
    if (!Number.isFinite(step)) return projection;
    const normalizedStep = Math.max(0, Math.floor(step));
    const observedSteps = normalizedStep + 1;
    if (projection.currentStep === normalizedStep && projection.stepCount >= observedSteps) return projection;
    return {
      ...projection,
      currentStep: normalizedStep,
      stepCount: Math.max(projection.stepCount, observedSteps),
    };
  }
  if (update.type === 'step-completed') {
    const step = Number(update.step_id);
    if (!Number.isFinite(step)) return projection;
    const normalizedStep = Math.max(0, Math.floor(step));
    return {
      ...projection,
      currentStep: projection.currentStep === normalizedStep ? undefined : projection.currentStep,
      stepCount: Math.max(projection.stepCount, normalizedStep + 1),
    };
  }
  return projection;
};

export const sanitizeCursorTaskResult = (value) => {
  if (!isPlainObject(value)) return value;
  const {
    transcriptPath: _transcriptPath,
    conversationSteps: _conversationSteps,
    ...safe
  } = value;
  if (!isPlainObject(safe.value)) return safe;
  const {
    transcriptPath: _nestedTranscriptPath,
    conversationSteps: _nestedConversationSteps,
    ...safeValue
  } = safe.value;
  return { ...safe, value: safeValue };
};
