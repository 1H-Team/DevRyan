const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const GATEWAY_TIMEOUT_MS = 120_000;
const GATEWAY_PATH = '/api/bots/private/gateway';
const CAPABILITY_PATTERN = /^[A-Za-z0-9._~-]{32,8192}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_IDENTITY_KEYS = new Set([
  'botId',
  'userId',
  'ownerUserId',
  'channelId',
  'runId',
  'revisionId',
  'scopeKey',
]);
const OPERATIONS = Object.freeze([
  'action.request',
  'artifact.get',
  'artifact.put',
  'computer.command',
  'image.generate',
  'library.search',
  'memory.search',
  'workspace.write',
]);
const ERROR_CODES = Object.freeze({
  inputInvalid: 'DEVRYAN_BOT_INPUT_INVALID',
  configInvalid: 'DEVRYAN_BOT_CONFIG_INVALID',
  aborted: 'DEVRYAN_BOT_ABORTED',
  gatewayUnavailable: 'DEVRYAN_BOT_GATEWAY_UNAVAILABLE',
  gatewayRejected: 'DEVRYAN_BOT_GATEWAY_REJECTED',
  responseInvalid: 'DEVRYAN_BOT_RESPONSE_INVALID',
  imageGenerationUnavailable: 'bot_image_generation_unavailable',
});

class DevRyanBotToolError extends Error {
  constructor(code, message, options = {}) {
    super(`${code}: ${message}`, options);
    this.name = 'DevRyanBotToolError';
    this.code = code;
  }
}

const fail = (code, message, options) => {
  throw new DevRyanBotToolError(code, message, options);
};

const requireId = (value, field) => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(ERROR_CODES.configInvalid, `${field} is invalid`);
  }
  return value;
};

const validateEnvironment = (environment = process.env) => {
  let gateway;
  try {
    gateway = new URL(environment.DEVRYAN_BOT_GATEWAY_URL);
  } catch {
    fail(ERROR_CODES.configInvalid, 'private gateway URL is invalid');
  }
  if (gateway.protocol !== 'http:' || gateway.hostname !== 'host.docker.internal'
    || !gateway.port || gateway.username || gateway.password || gateway.pathname !== '/'
    || gateway.search || gateway.hash) {
    fail(ERROR_CODES.configInvalid, 'private gateway URL is invalid');
  }
  const runtimeToken = environment.DEVRYAN_BOT_RUNTIME_TOKEN;
  if (typeof runtimeToken !== 'string' || !CAPABILITY_PATTERN.test(runtimeToken)) {
    fail(ERROR_CODES.configInvalid, 'runtime capability is invalid');
  }
  if (!['0', '1'].includes(environment.DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION)) {
    fail(ERROR_CODES.configInvalid, 'image generation capability is invalid');
  }
  return Object.freeze({
    gatewayUrl: new URL(GATEWAY_PATH, gateway).toString(),
    runtimeToken,
    runId: requireId(environment.DEVRYAN_BOT_RUN_ID, 'run capability'),
    channelId: requireId(environment.DEVRYAN_BOT_CHANNEL_ID, 'channel capability'),
    revisionId: requireId(environment.DEVRYAN_BOT_REVISION_ID, 'revision capability'),
    chatgptImageGeneration: environment.DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION === '1',
  });
};

const assertJsonPayload = (value, seen = new Set()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(ERROR_CODES.inputInvalid, 'payload contains a non-finite number');
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    if (!Array.isArray(value)) fail(ERROR_CODES.inputInvalid, 'payload must contain plain JSON values');
  }
  if (seen.has(value)) fail(ERROR_CODES.inputInvalid, 'payload cannot contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonPayload(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_IDENTITY_KEYS.has(key)) {
        fail(ERROR_CODES.inputInvalid, `payload cannot supply ${key}`);
      }
      assertJsonPayload(item, seen);
    }
  }
  seen.delete(value);
};

const validateInput = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(ERROR_CODES.inputInvalid, 'tool input must be an object');
  }
  const keys = Object.keys(input).sort();
  if (!['operation', 'payload'].every((key) => keys.includes(key))
    || keys.length !== 2 || !OPERATIONS.includes(input.operation)) {
    fail(ERROR_CODES.inputInvalid, 'tool input shape is invalid');
  }
  assertJsonPayload(input.payload);
  const encoded = JSON.stringify(input.payload);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) {
    fail(ERROR_CODES.inputInvalid, 'tool payload is too large');
  }
  return { operation: input.operation, payload: input.payload };
};

const validateImageInput = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail(ERROR_CODES.inputInvalid, 'image generation input must be an object');
  }
  const keys = Object.keys(payload);
  if (keys.some((key) => !['prompt', 'out', 'quality', 'size', 'images'].includes(key))
    || typeof payload.prompt !== 'string' || payload.prompt.length < 1 || payload.prompt.length > 16_384
    || typeof payload.out !== 'string' || payload.out.length < 1 || payload.out.length > 1_024
    || !['low', 'medium', 'high', 'auto'].includes(payload.quality)
    || (payload.size !== undefined && (typeof payload.size !== 'string' || payload.size.length > 64))
    || (payload.images !== undefined && (!Array.isArray(payload.images) || payload.images.length > 12
      || payload.images.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 1_024)))) {
    fail(ERROR_CODES.inputInvalid, 'image generation input is invalid');
  }
  const paths = [payload.out, ...(payload.images || [])];
  for (const candidate of paths) {
    const normalized = candidate.startsWith('/workspace/')
      ? candidate.slice('/workspace/'.length)
      : candidate;
    if (Buffer.byteLength(candidate, 'utf8') > 1_024 || candidate.includes('\0')
      || candidate.includes('\\')
      || (candidate.startsWith('/') && !candidate.startsWith('/workspace/'))) {
      fail(ERROR_CODES.inputInvalid, 'image paths must remain inside the workspace');
    }
    const segments = normalized.split('/');
    if (segments.length > 32 || segments.some((segment) => (
      !segment || segment === '.' || segment === '..'
      || Buffer.byteLength(segment, 'utf8') > 255
    ))
      || ['.devryan', '.opencode'].includes(segments[0]?.toLowerCase())) {
      fail(ERROR_CODES.inputInvalid, 'image paths must remain inside the workspace');
    }
  }
  return payload;
};

const workspaceWriteInput = (input, context) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join('\0') !== 'content\0path'
    || typeof input.path !== 'string'
    || typeof input.content !== 'string'
    || Buffer.byteLength(input.content, 'utf8') > 48 * 1024) {
    fail(ERROR_CODES.inputInvalid, 'workspace write input is invalid');
  }
  const normalizedPath = input.path.startsWith('/workspace/')
    ? input.path.slice('/workspace/'.length)
    : input.path.startsWith('/') ? input.path.slice(1) : input.path;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalizedPath)
    || ['.devryan', '.opencode'].includes(normalizedPath.toLowerCase())) {
    fail(ERROR_CODES.inputInvalid, 'workspace write input is invalid');
  }
  return Object.freeze({
    operation: 'workspace.write',
    payload: Object.freeze({
      idempotencyKey: requireId(context?.callID, 'tool call'),
      path: normalizedPath,
      content: input.content,
    }),
  });
};

const readBoundedJson = async (response) => {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail(ERROR_CODES.responseInvalid, 'private gateway response is invalid');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail(ERROR_CODES.responseInvalid, 'private gateway response is too large');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    fail(ERROR_CODES.responseInvalid, 'private gateway returned invalid JSON');
  }
};

const normalizeGatewayResult = (response, payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail(ERROR_CODES.responseInvalid, 'private gateway response is invalid');
  }
  if (response.ok) {
    if (payload.ok !== true || !Object.hasOwn(payload, 'result')
      || Object.keys(payload).sort().join('\0') !== 'ok\0result') {
      fail(ERROR_CODES.responseInvalid, 'private gateway success response is invalid');
    }
    if (typeof payload.result === 'string') return payload.result;
    const encoded = JSON.stringify(payload.result);
    if (typeof encoded !== 'string') {
      fail(ERROR_CODES.responseInvalid, 'private gateway result is invalid');
    }
    return encoded;
  }
  const code = payload?.error?.code;
  const message = payload?.error?.message;
  if (typeof code === 'string' && /^DEVRYAN_BOT_[A-Z0-9_]+$/.test(code)
    && typeof message === 'string' && message.length > 0 && message.length <= 512) {
    fail(code, message);
  }
  fail(ERROR_CODES.gatewayRejected, `private gateway rejected the operation (${response.status})`);
};

const executeGatewayOperation = async ({
  input,
  context,
  capability,
  fetchImpl,
}) => {
  const validated = validateInput(input);
  let response;
  try {
    const timeoutSignal = AbortSignal.timeout(GATEWAY_TIMEOUT_MS);
    const signal = context?.abort && typeof context.abort.addEventListener === 'function'
      ? AbortSignal.any([context.abort, timeoutSignal])
      : timeoutSignal;
    response = await fetchImpl(capability.gatewayUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability.runtimeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        runId: capability.runId,
        channelId: capability.channelId,
        revisionId: capability.revisionId,
        operation: validated.operation,
        payload: validated.payload,
      }),
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (context?.abort?.aborted || error?.name === 'AbortError') {
      fail(ERROR_CODES.aborted, 'operation was aborted', { cause: error });
    }
    fail(ERROR_CODES.gatewayUnavailable, 'private gateway is unavailable', { cause: error });
  }
  return normalizeGatewayResult(response, await readBoundedJson(response));
};

const createPlugin = async ({
  toolApi,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  imageToolFactory = null,
  beforeImage = async () => {},
} = {}) => {
  if (typeof toolApi !== 'function' || typeof fetchImpl !== 'function'
    || !toolApi.schema?.enum || !toolApi.schema?.unknown || !toolApi.schema?.string) {
    fail(ERROR_CODES.configInvalid, 'OpenCode tool runtime is unavailable');
  }
  const capability = validateEnvironment(environment);
  const exposedOperations = OPERATIONS.filter((operation) => operation !== 'image.generate');
  const imageTool = capability.chatgptImageGeneration && imageToolFactory
    ? await imageToolFactory()
    : null;
  const executeImage = async (input, context) => {
    const imageInput = validateImageInput(input);
    await beforeImage();
    try { return await imageTool.execute(imageInput, context); } catch (error) {
      // The reviewed dependency includes provider response text in exceptions.
      // Never send that body to tools, history, diagnostics or exports.
      if (typeof error?.message === 'string' && /^codex responses request failed: 401 /.test(error.message)) {
        throw Object.assign(new Error('bot_opencode_provider_authentication: Reconnect the selected host OpenAI account in Providers and Bot Settings.'),
          { code: 'bot_opencode_provider_authentication' });
      }
      fail('bot_image_generation_failed', 'Image generation failed. No provider response details were retained.');
    }
  };
  const tools = {
    devryan_bot: toolApi({
      description: 'The authenticated DevRyan Bot gateway, including the persistent browser connector. For browser work use operation computer.command with payload { idempotencyKey, command, args, target, limits }; start with navigate or snapshot and use returned element refs for interactions. The browser is available whenever the Bot is Active. Image generation is a separate devryan_image tool; never guess an image.generate gateway payload.',
      args: {
        operation: toolApi.schema.enum(exposedOperations),
        payload: toolApi.schema.unknown(),
      },
      execute: async (input, context) => {
        const validated = validateInput(input);
        if (validated.operation === 'image.generate') {
          if (!capability.chatgptImageGeneration || typeof imageTool?.execute !== 'function') {
            fail(ERROR_CODES.imageGenerationUnavailable,
              'ChatGPT OAuth image generation is unavailable for this run');
          }
          return executeImage(validated.payload, context);
        }
        return executeGatewayOperation({ input, context, capability, fetchImpl });
      },
    }),
    devryan_write: toolApi({
      description: 'Create or replace one file in the isolated Bot workspace. This write always follows the configured action policy and may pause for human approval.',
      args: {
        path: toolApi.schema.string(),
        content: toolApi.schema.string(),
      },
      execute: async (input, context) => executeGatewayOperation({
        input: workspaceWriteInput(input, context),
        context,
        capability,
        fetchImpl,
      }),
    }),
  };
  if (imageTool && typeof imageTool.execute === 'function' && imageTool.args) {
    tools.devryan_image = toolApi({
      description: 'Generate a raster image with the authorized ChatGPT image tool. Required arguments are prompt, out, and quality; size and images are optional. Save out inside /workspace, for example /workspace/generated-images/result.png. Successful images attach to the assistant reply automatically.',
      args: imageTool.args,
      execute: executeImage,
    });
  }
  return {
    tool: tools,
  };
};

const DevRyanBotPlugin = async (pluginInput) => {
  const { tool } = await import('@opencode-ai/plugin');
  const { default: oauthPlugin } = await import('/opt/devryan/devryan-openai-oauth.mjs');
  const oauthHooks = await oauthPlugin(pluginInput);
  const tools = await createPlugin({
    toolApi: tool,
    beforeImage: () => oauthHooks['tool.execute.before']?.({ tool: 'devryan_image' }),
    imageToolFactory: async () => {
      const { default: imagePlugin } = await import('opencode-gpt-imagegen');
      if (!imagePlugin || typeof imagePlugin.server !== 'function') {
        fail(ERROR_CODES.configInvalid, 'reviewed image generation plugin is unavailable');
      }
      const loaded = await imagePlugin.server(pluginInput);
      if (!loaded?.tool?.gpt_imagegen) {
        fail(ERROR_CODES.configInvalid, 'reviewed image generation tool is unavailable');
      }
      return loaded.tool.gpt_imagegen;
    },
  });
  return { ...tools, ...(oauthHooks.config ? { config: oauthHooks.config } : {}) };
};

export default DevRyanBotPlugin;

// OpenCode invokes every ESM export as a plugin factory. Keep the test surface
// callable while attaching dependency-free helpers for contract tests.
export const __test = Object.assign(() => ({}), {
  ERROR_CODES,
  OPERATIONS,
  createPlugin,
  executeGatewayOperation,
  validateEnvironment,
  validateImageInput,
  validateInput,
  workspaceWriteInput,
});
