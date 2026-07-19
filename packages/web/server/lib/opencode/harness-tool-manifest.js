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

function appendQuery(url, entries) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(entries)) {
    if (value) next.searchParams.set(key, value);
  }
  return next.toString();
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

async function readJsonEndpoint({ fetchImpl, getUrl, headers, validate, timeoutMs }) {
  const abortController = new AbortController();
  let timedOut = false;
  let timeoutHandle;
  const timeoutResult = unavailableEndpoint({ kind: 'timeout' });
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve(timeoutResult);
      abortController.abort();
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const requestPromise = (async () => {
      const response = await fetchImpl(getUrl(), {
        headers,
        signal: abortController.signal,
      });
      if (!response.ok) {
        return unavailableEndpoint({ kind: 'httpError', httpStatus: response.status });
      }
      const data = await response.json();
      if (!validate(data)) {
        return unavailableEndpoint({ kind: 'invalidPayload' });
      }
      return {
        data,
        availability: { availability: 'available' },
      };
    })();
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch {
    return timedOut
      ? timeoutResult
      : unavailableEndpoint({ kind: 'requestFailed' });
  } finally {
    clearTimeout(timeoutHandle);
  }
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

function createHarnessToolManifestReader(dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl;
  const buildOpenCodeUrl = dependencies.buildOpenCodeUrl;
  const getOpenCodeAuthHeaders = dependencies.getOpenCodeAuthHeaders;
  const requestedTimeoutMs = Number(dependencies.toolRequestTimeoutMs);
  const toolRequestTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.trunc(requestedTimeoutMs)
    : DEFAULT_TOOL_REQUEST_TIMEOUT_MS;

  return async function readHarnessToolManifest(context = {}) {
    const directory = normalizeOptionalString(context.directory);
    const providerID = normalizeOptionalString(context.providerID);
    const modelID = normalizeOptionalString(context.modelID);
    let headers = {};
    try {
      headers = typeof getOpenCodeAuthHeaders === 'function'
        ? await getOpenCodeAuthHeaders()
        : {};
    } catch {
      const unavailable = {
        availability: 'unavailable',
        error: { kind: 'authHeadersUnavailable' },
      };
      return {
        tools: [],
        toolIds: [],
        aliases: {},
        sourceRuntime: 'server',
        directory,
        selector: {
          mode: providerID && modelID ? 'providerModel' : 'idsOnly',
          providerID,
          modelID,
        },
        availability: {
          ids: unavailable,
          catalog: providerID && modelID ? unavailable : { availability: 'notRequested' },
        },
      };
    }
    const idsRequest = readJsonEndpoint({
      fetchImpl,
      getUrl: () => appendQuery(buildOpenCodeUrl('/experimental/tool/ids'), { directory }),
      headers,
      validate: isToolIdPayload,
      timeoutMs: toolRequestTimeoutMs,
    });
    const catalogRequest = providerID && modelID
      ? readJsonEndpoint({
          fetchImpl,
          getUrl: () => appendQuery(buildOpenCodeUrl('/experimental/tool'), {
            directory,
            provider: providerID,
            model: modelID,
          }),
          headers,
          validate: isToolCatalogPayload,
          timeoutMs: toolRequestTimeoutMs,
        })
      : Promise.resolve({
          data: null,
          availability: { availability: 'notRequested' },
        });
    const [idsResult, catalogResult] = await Promise.all([idsRequest, catalogRequest]);
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
  };
}

export {
  DEFAULT_TOOL_REQUEST_TIMEOUT_MS,
  TOOL_PERMISSION_ALIAS_GROUPS,
  createHarnessToolManifestReader,
  getToolPermissionAliases,
};
