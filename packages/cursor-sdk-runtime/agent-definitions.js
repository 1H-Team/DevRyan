const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const normalizeModelSelectionParams = (params) => {
  if (!Array.isArray(params)) return [];
  const normalized = [];
  for (const param of params) {
    if (!isPlainObject(param)) continue;
    const id = trimString(param.id);
    const value = trimString(param.value);
    if (!id || !value) continue;
    normalized.push({ id, value });
  }
  return normalized;
};

export const normalizeCursorSdkModelSelection = (selection, fallbackModelID = '') => {
  if (!isPlainObject(selection)) {
    const fallback = trimString(fallbackModelID);
    return fallback ? { id: fallback } : null;
  }

  const id = trimString(selection.id) || trimString(fallbackModelID);
  if (!id) return null;
  const params = normalizeModelSelectionParams(selection.params);
  return {
    id,
    ...(params.length > 0 ? { params } : {}),
  };
};

const normalizeCursorSdkAgentModel = (model) => {
  if (model === 'inherit') return 'inherit';
  return normalizeCursorSdkModelSelection(model) || 'inherit';
};

const sortObjectKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObjectKeys(entry)])
  );
};

export const normalizeCursorSdkAgentDefinitions = (value) => {
  if (!isPlainObject(value)) return null;
  const definitions = {};
  for (const [rawName, rawDefinition] of Object.entries(value)) {
    const name = trimString(rawName);
    if (!name || !isPlainObject(rawDefinition)) continue;
    const prompt = trimString(rawDefinition.prompt);
    if (!prompt) continue;
    definitions[name] = {
      description: trimString(rawDefinition.description) || `${name} subagent`,
      prompt,
      model: normalizeCursorSdkAgentModel(rawDefinition.model),
    };
  }
  return Object.keys(definitions).length > 0 ? sortObjectKeys(definitions) : null;
};

export const pinCursorSdkSubagentModels = (definitions, modelSelection) => {
  const normalizedDefinitions = normalizeCursorSdkAgentDefinitions(definitions);
  if (!normalizedDefinitions) return normalizedDefinitions;

  const parentSelection = normalizeCursorSdkModelSelection(modelSelection);
  if (!parentSelection || parentSelection.id === 'auto') return normalizedDefinitions;

  const pinned = {};
  for (const [name, definition] of Object.entries(normalizedDefinitions)) {
    const explicitSelection = normalizeCursorSdkModelSelection(definition.model);
    pinned[name] = {
      ...definition,
      model: explicitSelection || parentSelection,
    };
  }
  return sortObjectKeys(pinned);
};
