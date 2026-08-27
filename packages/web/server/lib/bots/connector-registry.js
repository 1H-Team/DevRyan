const CONNECTOR_METHODS = Object.freeze([
  'describeActions',
  'validate',
  'authorize',
  'execute',
  'reconcile',
  'revoke',
]);

const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9._-]{0,119}$/;

export class BotConnectorRegistryError extends Error {
  constructor(message, code = 'bot_connector_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotConnectorRegistryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotConnectorRegistryError(message, code, statusCode);
};

const normalizeId = (value) => {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!CONNECTOR_ID_PATTERN.test(id)) fail('Bot connector ID is invalid');
  return id;
};

const validateConnector = (connector) => {
  if (!connector || typeof connector !== 'object' || Array.isArray(connector)
    || Object.keys(connector).sort().join('\0') !== ['id', ...CONNECTOR_METHODS].sort().join('\0')) {
    fail('Bot connector contract is invalid', 'bot_connector_contract_invalid', 500);
  }
  const id = normalizeId(connector.id);
  if (CONNECTOR_METHODS.some((method) => typeof connector[method] !== 'function')) {
    fail('Bot connector contract is invalid', 'bot_connector_contract_invalid', 500);
  }
  return Object.freeze({ id, connector });
};

const cloneJson = (value) => {
  try {
    return structuredClone(value);
  } catch {
    fail('Bot connector payload is invalid');
  }
};

export function createBotConnectorRegistry({ connectors = [] } = {}) {
  if (!Array.isArray(connectors)) {
    throw new TypeError('Bot connector registry requires an array');
  }
  const registered = new Map();

  const register = (connector) => {
    const normalized = validateConnector(connector);
    if (registered.has(normalized.id)) {
      fail('Bot connector is already registered', 'bot_connector_duplicate', 409);
    }
    registered.set(normalized.id, normalized.connector);
    return normalized.id;
  };

  for (const connector of connectors) register(connector);

  const requireConnector = (connectorId) => {
    const id = normalizeId(connectorId);
    const connector = registered.get(id);
    if (!connector) {
      fail(
        'The requested Bot connector is not registered',
        'bot_connector_unregistered',
        403,
      );
    }
    return Object.freeze({ id, connector });
  };

  const invoke = async (connectorId, method, input) => {
    const { connector } = requireConnector(connectorId);
    return cloneJson(await connector[method](cloneJson(input)));
  };

  return Object.freeze({
    register,
    has: (connectorId) => {
      try {
        return registered.has(normalizeId(connectorId));
      } catch {
        return false;
      }
    },
    ids: () => Object.freeze([...registered.keys()].sort()),
    async describeActions() {
      const descriptions = [];
      for (const id of [...registered.keys()].sort()) {
        descriptions.push(Object.freeze({
          connectorId: id,
          actions: await invoke(id, 'describeActions', {}),
        }));
      }
      return Object.freeze(descriptions);
    },
    validate: (connectorId, input) => invoke(connectorId, 'validate', input),
    authorize: (connectorId, input) => invoke(connectorId, 'authorize', input),
    execute: (connectorId, input) => invoke(connectorId, 'execute', input),
    reconcile: (connectorId, input) => invoke(connectorId, 'reconcile', input),
    revoke: (connectorId, input) => invoke(connectorId, 'revoke', input),
  });
}

export const BOT_CONNECTOR_METHODS = CONNECTOR_METHODS;
