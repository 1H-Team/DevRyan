import { OPENCODE_CLIENT_ERROR_CODES } from './opencode-client/index.js';
import { openCodeClientErrorStatus, resolveGen2OpenCodeClient } from './opencode-client-seam.js';

const TOOL_PERMISSION_ALIAS_GROUPS = [
  ['edit', 'write', 'patch', 'apply_patch'],
  ['read'],
  ['bash'],
  ['task'],
  ['skill'],
  ['question', 'ask', 'input', 'clarification'],
  ['webfetch'],
];
const DEFAULT_TOOL_REQUEST_TIMEOUT_MS = 5_000;

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getToolPermissionAliases(toolId) {
  const group = TOOL_PERMISSION_ALIAS_GROUPS.find((aliases) => aliases.includes(toolId));
  return group ? [...group] : [toolId];
}

function buildAliases(toolIds) {
  return Object.fromEntries(toolIds.map((toolId) => [toolId, getToolPermissionAliases(toolId)]));
}

function unavailableEndpoint(error) {
  return {
    data: null,
    availability: {
      availability: 'unavailable',
      error,
    },
  };
}

function isToolIdPayload(value) {
  return Array.isArray(value) && value.every((toolId) => typeof toolId === 'string');
}

function isToolCatalogPayload(value) {
  return Array.isArray(value) && value.every((tool) => (
    tool
    && typeof tool === 'object'
    && typeof tool.id === 'string'
    && typeof tool.description === 'string'
    && Object.hasOwn(tool, 'parameters')
  ));
}

// Client failures raised before any upstream answer (no usable status).
const LOCAL_CLIENT_ERROR_CODES = new Set([
  OPENCODE_CLIENT_ERROR_CODES.locationRequired,
  OPENCODE_CLIENT_ERROR_CODES.locationInvalid,
  OPENCODE_CLIENT_ERROR_CODES.routeDenied,
  OPENCODE_CLIENT_ERROR_CODES.generationInvalid,
  OPENCODE_CLIENT_ERROR_CODES.invalidResponse,
]);

function clientFailure(error) {
  const status = openCodeClientErrorStatus(error);
  if (status > 0 && !LOCAL_CLIENT_ERROR_CODES.has(error?.code)) {
    return { kind: 'httpError', httpStatus: status };
  }
  if (error?.code === OPENCODE_CLIENT_ERROR_CODES.invalidResponse) return { kind: 'invalidPayload' };
  return { kind: 'requestFailed' };
}

/**
 * Gen 2: one read of the host's sealed tool snapshot (`catalog.tools`, the
 * `GET /devryan/tools` host route, DESIGN.md C.6) yields both endpoints'
 * availability. The snapshot already carries v1 tool names.
 */
async function readClientToolSnapshot({ client, directory, providerID, modelID, timeoutMs }) {
  const withModel = Boolean(providerID && modelID);
  const abortController = new AbortController();
  let timeoutHandle;
  const timedOut = { ids: unavailableEndpoint({ kind: 'timeout' }), catalog: unavailableEndpoint({ kind: 'timeout' }) };
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve(timedOut);
      abortController.abort();
    }, timeoutMs);
    timeoutHandle.unref?.();
  });
  const requestPromise = (async () => {
    try {
      const snapshot = await client.catalog.tools(
        withModel ? { directory, providerID, modelID } : { directory },
        { signal: abortController.signal },
      );
      const ids = isToolIdPayload(snapshot?.ids)
        ? { data: snapshot.ids, availability: { availability: 'available' } }
        : unavailableEndpoint({ kind: 'invalidPayload' });
      const catalog = isToolCatalogPayload(snapshot?.definitions)
        ? { data: snapshot.definitions, availability: { availability: 'available' } }
        : unavailableEndpoint({ kind: 'invalidPayload' });
      return { ids, catalog };
    } catch (error) {
      const failed = unavailableEndpoint(clientFailure(error));
      return { ids: failed, catalog: failed };
    }
  })();
  try {
    const result = await Promise.race([requestPromise, timeoutPromise]);
    return {
      ids: result.ids,
      catalog: withModel ? result.catalog : { data: null, availability: { availability: 'notRequested' } },
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildManifest({ directory, providerID, modelID, idsResult, catalogResult }) {
  const toolIds = idsResult.data || [];
  const catalog = catalogResult.data;
  const aliases = buildAliases(toolIds);
  const manifestTools = catalog || toolIds.map((id) => ({ id }));

  return {
    tools: manifestTools.map((tool) => ({
      ...tool,
      aliases: getToolPermissionAliases(tool.id),
      sourceRuntime: 'server',
      directory,
    })),
    toolIds: [...toolIds],
    aliases,
    sourceRuntime: 'server',
    directory,
    selector: {
      mode: providerID && modelID ? 'providerModel' : 'idsOnly',
      providerID,
      modelID,
    },
    availability: {
      ids: idsResult.availability,
      catalog: catalogResult.availability,
    },
  };
}

function createHarnessToolManifestReader(dependencies = {}) {
  const requestedTimeoutMs = Number(dependencies.toolRequestTimeoutMs);
  const toolRequestTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.trunc(requestedTimeoutMs)
    : DEFAULT_TOOL_REQUEST_TIMEOUT_MS;

  return async function readHarnessToolManifest(context = {}) {
    const directory = normalizeOptionalString(context.directory);
    const providerID = normalizeOptionalString(context.providerID);
    const modelID = normalizeOptionalString(context.modelID);
    let client = null;
    try {
      client = resolveGen2OpenCodeClient(dependencies.openCodeClient);
    } catch {
      // An unknown generation never falls back to the gen-1 routes.
      const failed = unavailableEndpoint({ kind: 'requestFailed' });
      return buildManifest({
        directory,
        providerID,
        modelID,
        idsResult: failed,
        catalogResult: providerID && modelID ? failed : { data: null, availability: { availability: 'notRequested' } },
      });
    }
    const snapshot = await readClientToolSnapshot({ client, directory, providerID, modelID, timeoutMs: toolRequestTimeoutMs });
    return buildManifest({ directory, providerID, modelID, idsResult: snapshot.ids, catalogResult: snapshot.catalog });
  };
}

export {
  DEFAULT_TOOL_REQUEST_TIMEOUT_MS,
  TOOL_PERMISSION_ALIAS_GROUPS,
  createHarnessToolManifestReader,
  getToolPermissionAliases,
};
