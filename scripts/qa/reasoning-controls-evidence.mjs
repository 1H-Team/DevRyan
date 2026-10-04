import { createHash } from 'node:crypto';
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

// Pinned provider serializers change these exact control spellings. Compare
// their meanings against the final physical body, never against a copied
// Prepared value. Unknown transport controls cannot establish wire evidence.
const wireContainsControls = (actual, expected) => actual !== null && actual !== undefined
  && Object.entries(expected).every(([key, value]) => {
    if (key === 'reasoningEffort') return [actual.reasoningEffort, actual.reasoning_effort, actual.reasoning?.effort].includes(value);
    if (key === 'reasoningSummary') return [actual.reasoningSummary, actual.reasoning?.summary].includes(value);
    if (key === 'outputConfig' || key === 'output_config') return [actual.outputConfig, actual.output_config].some(candidate => candidate && containsControls(candidate, value));
    if (key === 'thinking' && value && typeof value === 'object') return Object.entries(value).every(([name, control]) =>
      ['budgetTokens', 'budget_tokens'].includes(name)
        ? [actual.thinking?.budgetTokens, actual.thinking?.budget_tokens].includes(control)
        : actual.thinking?.[name] === control);
    return containsControls(actual, { [key]: value });
  });

const sameAttempt = (left, right) => left !== null && right !== null && left?.traceID === right?.traceID && left?.spanID === right?.spanID;
const sameScope = (left, right) => ['controllerInstanceID', 'configurationDigest', 'sessionID', 'directory'].every(key => left[key] === right[key]);

// Generation 2 evidence is the actual Prepared request and physical attempt,
// joined to the durable native step. It is never renamed to a v1 plugin hook.
export function gradeQaNativeReasoningControls({ observations, userMessageIDs, sessionID, directory, configurationDigest,
  agent, providerID, modelID, variant, advertisedVariant }) {
  const expectedControls = variant === null ? {} : projectReasoningOptions(advertisedVariant);
  const expected = { agent, providerID, modelID, variant };
  const executionMatches = row => row.execution && Object.entries(expected).every(([key, value]) =>
    key === 'variant' && value === null ? [null, 'default'].includes(row.execution[key]) : row.execution[key] === value);
  const directoryWitness = `<WORKTREE_${createHash('sha256').update(directory ?? '').digest('hex').slice(0, 12)}>`;
  const relevant = observations.filter(row => row.schema === 1 && row.sessionID === sessionID && row.directory === directoryWitness
    && row.configurationDigest === configurationDigest);
  const prepared = relevant.filter(row => row.stage === 'model-prepared' && row.kind === 'primary');
  const physical = relevant.filter(row => row.stage === 'physical' && row.kind === 'primary');
  const steps = relevant.filter(row => row.stage === 'step-link');
  const links = physical.map(row => ({ physical: row,
    prepared: prepared.find(candidate => candidate.requestID === row.requestID && sameScope(candidate, row)),
    steps: steps.filter(candidate => sameScope(candidate, row) && sameAttempt(candidate.attempt, row.attempt)) }));
  const unmatchedPhysicalAttempts = links.filter(link => !link.prepared || link.steps.length !== 1).map(link => ({
    requestID: link.physical.requestID, transport: link.physical.transport, ordinal: link.physical.ordinal,
    attempt: link.physical.attempt, reason: !link.prepared ? 'missing-prepared' : link.steps.length ? 'ambiguous-step' : 'no-canonical-step',
  }));
  const ids = [...new Set(userMessageIDs)];
  const turns = ids.map(messageID => {
    const accepted = relevant.filter(row => row.stage === 'accepted-user' && row.messageID === messageID);
    const intentMatches = accepted.length > 0 && accepted.every(row => executionMatches(row) && row.intent.variantPresent
      && (variant === null ? [null, ''].includes(row.intent.variant) : row.intent.variant === variant)
      && (row.intent.agent === undefined || row.intent.agent === agent)
      && (row.intent.model === undefined || row.intent.model.providerID === providerID && row.intent.model.modelID === modelID));
    const actual = links.filter(link => link.steps.length === 1 && link.steps[0].userMessageID === messageID);
    const parameterMatches = actual.length > 0 && actual.every(link => link.prepared && executionMatches(link.prepared)
      && executionMatches(link.steps[0]) && accepted.some(row => sameScope(row, link.physical))
      && containsControls(link.prepared.options, expectedControls)
      && wireContainsControls(link.physical.wireOptions, expectedControls));
    return { messageID, inputMatches: intentMatches, parameterMatches,
      nativeResolvedControls: actual.map(link => link.prepared?.options ?? null),
      nativeHookControls: actual.map(link => link.prepared?.hookOptions ?? null),
      providerWireControls: actual.map(link => link.physical.wireOptions),
      requests: actual.map(link => ({ requestID: link.physical.requestID, transport: link.physical.transport,
        ordinal: link.physical.ordinal, attempt: link.physical.attempt, eventID: link.steps[0].eventID,
        sequence: link.steps[0].sequence, created: link.steps[0].created, assistantMessageID: link.steps[0].assistantMessageID })),
      intents: accepted.map(row => row.intent) };
  });
  return { passed: ids.length > 0 && typeof agent === 'string' && typeof directory === 'string'
    && /^[a-f0-9]{64}$/.test(configurationDigest ?? '') && (variant === null || Object.keys(expectedControls).length > 0)
    && turns.every(turn => turn.inputMatches && turn.parameterMatches),
    selection: variant === null ? 'provider-default' : variant, expectedControls, turns, unmatchedPhysicalAttempts,
    coverage: 'required-successful-user-turns-with-canonical-step-links', unmatchedPhysicalAttemptCount: unmatchedPhysicalAttempts.length,
    observedStage: 'native-prepared-after-hooks', providerWireControls: 'final-physical-named-controls-with-canonical-step-link' };
}
