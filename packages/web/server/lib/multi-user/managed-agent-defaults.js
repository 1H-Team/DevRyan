const MAX_AGENT_NAME_LENGTH = 80;
const MAX_PROVIDER_ID_LENGTH = 80;
const MAX_MODEL_ID_LENGTH = 180;
const MAX_VARIANT_LENGTH = 80;
const MAX_PAYLOAD_BYTES = 1_024;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isVisibleAscii = (value) => /^[\x21-\x7e]+$/.test(value);

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

const validateIdentifier = (value, label, maxLength, { allowSlash = true } = {}) => {
  const normalized = clean(value);
  if (!normalized || normalized.length > maxLength || !isVisibleAscii(normalized)) {
    throw Object.assign(new Error(`${label} is invalid`), { statusCode: 400 });
  }
  const pattern = allowSlash
    ? /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/
    : /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
  if (!pattern.test(normalized)) {
    throw Object.assign(new Error(`${label} is invalid`), { statusCode: 400 });
  }
  return normalized;
};

export const findManagedAgent = (agents, agentName) => {
  const normalized = clean(agentName).toLowerCase();
  if (!normalized) return null;
  return (Array.isArray(agents) ? agents : []).find((agent) => (
    clean(agent?.name).toLowerCase() === normalized
  )) || null;
};

export const executionFromManagedAgent = (agent) => {
  const providerId = clean(agent?.model?.providerID ?? agent?.model?.providerId);
  const modelId = clean(agent?.model?.modelID ?? agent?.model?.modelId);
  if (!providerId || !modelId) return null;
  return {
    providerId,
    modelId,
    variant: clean(agent?.variant) || null,
  };
};

/**
 * Host-configured backup execution for a managed agent (Settings → Agents →
 * Backup model). Null when none is set. Only consulted when the primary model
 * hits a provider usage limit; never a substitute for executionFromManagedAgent.
 */
export const backupExecutionFromManagedAgent = (agent) => {
  const backup = agent?.backupModel;
  if (!isRecord(backup)) return null;
  const providerId = clean(backup.providerID ?? backup.providerId);
  const modelId = clean(backup.modelID ?? backup.modelId);
  if (!providerId || !modelId) return null;
  return {
    providerId,
    modelId,
    variant: clean(backup.variant) || null,
  };
};

export const isSingleModelManagedAgent = (agent) => {
  if (!agent || !executionFromManagedAgent(agent)) return false;
  if (Array.isArray(agent.councillors) && agent.councillors.length > 0) return false;
  if (Array.isArray(agent.modelRefs) && agent.modelRefs.length > 1) return false;
  return clean(agent.name).toLowerCase() !== 'council';
};

export const getPersonalAgentDefault = (settingsOverrides, agentName) => {
  const selections = isRecord(settingsOverrides?.agentModelSelections)
    ? settingsOverrides.agentModelSelections
    : {};
  const normalized = clean(agentName).toLowerCase();
  const entry = Object.entries(selections).find(([name]) => clean(name).toLowerCase() === normalized);
  if (!entry || !isRecord(entry[1])) return null;
  const providerId = clean(entry[1].providerId);
  const modelId = clean(entry[1].modelId);
  if (!providerId || !modelId) return null;
  return {
    providerId,
    modelId,
    variant: clean(entry[1].variant) || null,
  };
};

export const validatePersonalAgentDefault = ({ agentName, payload, agents }) => {
  const requestedName = clean(agentName);
  if (!requestedName || requestedName.length > MAX_AGENT_NAME_LENGTH || /[\x00-\x1f\x7f/]/.test(requestedName)) {
    throw Object.assign(new Error('Agent name is invalid'), { statusCode: 400 });
  }
  if (!isRecord(payload) || Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    throw Object.assign(new Error('Agent default payload is invalid'), { statusCode: 400 });
  }
  const unknownKeys = Object.keys(payload).filter((key) => !['providerId', 'modelId', 'variant'].includes(key));
  if (unknownKeys.length > 0) {
    throw Object.assign(new Error(`Unknown agent default field: ${unknownKeys[0]}`), { statusCode: 400 });
  }

  const agent = findManagedAgent(agents, requestedName);
  if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
  if (!isSingleModelManagedAgent(agent)) {
    throw Object.assign(new Error('This agent is managed by the host and cannot have a personal model default'), {
      statusCode: 409,
      code: 'AGENT_DEFAULT_HOST_MANAGED',
    });
  }

  const providerId = validateIdentifier(payload.providerId, 'Provider ID', MAX_PROVIDER_ID_LENGTH, { allowSlash: false });
  const modelId = validateIdentifier(payload.modelId, 'Model ID', MAX_MODEL_ID_LENGTH);
  let variant;
  if (Object.prototype.hasOwnProperty.call(payload, 'variant')) {
    variant = validateIdentifier(payload.variant, 'Thinking value', MAX_VARIANT_LENGTH, { allowSlash: false });
  }

  return {
    agentName: clean(agent.name),
    selection: {
      providerId,
      modelId,
      ...(variant ? { variant } : {}),
    },
  };
};

export const resolveManagedAgentExecution = ({ agents, agentName, settingsOverrides }) => {
  const agent = findManagedAgent(agents, agentName);
  const hostExecution = executionFromManagedAgent(agent);
  if (!agent || !hostExecution) return null;
  if (!isSingleModelManagedAgent(agent)) {
    return { ...hostExecution, agentName: clean(agent.name), source: 'host-managed' };
  }
  const personal = getPersonalAgentDefault(settingsOverrides, agent.name);
  return personal
    ? { ...personal, agentName: clean(agent.name), source: 'personal' }
    : { ...hostExecution, agentName: clean(agent.name), source: 'inherited' };
};
