const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) ? value : null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

// Observe only named reasoning controls. Prompts, headers, credentials, arbitrary
// options and model output never enter this private acceptance evidence.
export const projectReasoningOptions = options => {
  const source = options && typeof options === 'object' ? options : {};
  const result = {};
  for (const key of ['reasoningEffort', 'reasoningSummary', 'effort', 'thinkingLevel']) {
    if (id(source[key])) result[key] = source[key];
  }
  for (const key of ['thinkingBudget', 'maxThinkingTokens']) {
    if (numeric(source[key]) !== null) result[key] = source[key];
  }
  if (source.thinking && typeof source.thinking === 'object') {
    const thinking = {};
    if (id(source.thinking.type)) thinking.type = source.thinking.type;
    for (const key of ['budgetTokens', 'budget_tokens']) {
      if (numeric(source.thinking[key]) !== null) thinking[key] = source.thinking[key];
    }
    if (Object.keys(thinking).length) result.thinking = thinking;
  }
  if (source.reasoning && typeof source.reasoning === 'object') {
    const reasoning = {};
    for (const key of ['effort', 'summary']) {
      if (id(source.reasoning[key])) reasoning[key] = source.reasoning[key];
    }
    if (Object.keys(reasoning).length) result.reasoning = reasoning;
  }
  for (const key of ['outputConfig', 'output_config']) {
    if (id(source[key]?.effort)) result[key] = { effort: source[key].effort };
  }
  return result;
};

const containsControls = (actual, expected) => Object.entries(expected).every(([key, value]) => {
  if (value && typeof value === 'object') return actual?.[key] && containsControls(actual[key], value);
  return actual?.[key] === value;
});

// This grades the final native chat.params hook, before the provider adapter.
// Defaults introduced by that native adapter are reported as observed; the
// default selection must explicitly clear the configured agent variant first.
export const gradeQaReasoningControls = ({ observations, userMessageIDs, sessionID, providerID, modelID, variant, advertisedVariant }) => {
  const expectedVariant = variant === null ? '' : variant;
  const expectedControls = variant === null ? {} : projectReasoningOptions(advertisedVariant);
  const ids = [...new Set(userMessageIDs)];
  const turns = ids.map(messageID => {
    const rows = observations.filter(row => row.sessionID === sessionID && row.messageID === messageID);
    const inputs = rows.filter(row => row.kind === 'chat.message');
    const parameters = rows.filter(row => row.kind === 'chat.params');
    const inputMatches = inputs.length > 0 && inputs.every(row => row.variantPresent && row.variant === expectedVariant
      && row.providerID === providerID && row.modelID === modelID);
    const parameterMatches = parameters.length > 0 && parameters.every(row => row.providerID === providerID && row.modelID === modelID
      && containsControls(row.options, expectedControls));
    return { messageID, inputMatches, parameterMatches, nativeResolvedControls: parameters.map(row => row.options) };
  });
  return { passed: ids.length > 0 && (variant === null || Object.keys(expectedControls).length > 0)
    && turns.every(turn => turn.inputMatches && turn.parameterMatches),
  selection: variant === null ? 'provider-default' : variant, expectedControls, turns,
  observedStage: 'native-chat-params-after-configured-plugins-before-adapter', providerWireControls: 'not-captured' };
};
