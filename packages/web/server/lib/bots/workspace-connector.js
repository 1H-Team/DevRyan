import {
  assertExactObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const WORKSPACE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TRANSPORT_UNCERTAIN_CODES = new Set([
  'bot_runtime_supervisor_unavailable',
  'bot_runtime_supervisor_request_failed',
  'bot_runtime_supervisor_response_invalid',
  'bot_supervisor_docker_api_error',
  'bot_supervisor_docker_unavailable',
]);

export class BotWorkspaceConnectorError extends Error {
  constructor(message, code = 'bot_workspace_write_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotWorkspaceConnectorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotWorkspaceConnectorError(message, code, statusCode);
};

const normalizeFile = (target, args) => {
  try {
    assertExactObject(target, {
      label: 'Bot workspace target',
      required: ['path'],
      optional: ['operationKind'],
    });
    assertExactObject(args, { label: 'Bot workspace arguments', required: ['content'] });
    if (target.operationKind !== undefined && target.operationKind !== 'write') {
      fail('Bot workspace operation kind is invalid');
    }
    const path = validateBoundedString(target.path, 'Bot workspace path', {
      maximum: 128,
      pattern: WORKSPACE_FILE_PATTERN,
    });
    if (['.devryan', '.opencode'].includes(path.toLowerCase())) {
      fail('Bot workspace path is reserved');
    }
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > 48 * 1024) {
      fail('Bot workspace content is invalid');
    }
    return Object.freeze({ path, content: args.content });
  } catch (error) {
    if (error instanceof BotWorkspaceConnectorError) throw error;
    fail(error.message);
  }
};

export function createBotWorkspaceConnector({ dockerProvider } = {}) {
  if (!dockerProvider || typeof dockerProvider.writeWorkspace !== 'function') {
    throw new TypeError('Bot workspace connector is misconfigured');
  }
  return Object.freeze({
    id: 'workspace',
    async describeActions() {
      return Object.freeze([{
        name: 'write',
        operationKind: 'write',
        description: 'Create or replace one reviewed file in the isolated Bot workspace.',
      }]);
    },
    async validate(input) {
      if (input?.action !== 'write') {
        fail('Bot workspace action is unavailable', 'bot_workspace_action_unavailable', 403);
      }
      const file = normalizeFile(input.target, input.args);
      return Object.freeze({
        target: Object.freeze({ path: file.path }),
        args: Object.freeze({ content: file.content }),
        operationKind: 'write',
      });
    },
    async authorize(input) {
      if (input?.action?.tool !== 'connector:workspace'
        || input.action.action !== 'write'
        || input?.policyDecision?.operationKind !== 'write') {
        fail('Bot workspace authorization is invalid', 'bot_workspace_authorization_invalid', 403);
      }
      return Object.freeze({ authorized: true });
    },
    async execute(input) {
      const file = normalizeFile(input?.target, input?.args);
      try {
        const result = await dockerProvider.writeWorkspace({
          botId: validateUuid(input?.botId, 'botId'),
          channelId: validateUuid(input?.channelId, 'channelId'),
          path: file.path,
          content: file.content,
        });
        return Object.freeze({
          result,
          connectorReceipt: Object.freeze({
            nativeExactlyOnce: false,
            writeGuarantee: 'idempotent_content_replace',
          }),
        });
      } catch (error) {
        if (TRANSPORT_UNCERTAIN_CODES.has(error?.code) && error && typeof error === 'object') {
          error.transportUncertain = true;
        }
        throw error;
      }
    },
    async reconcile() {
      return Object.freeze({ state: 'unknown', automatic: false });
    },
    async revoke() {
      return Object.freeze({ revoked: true });
    },
  });
}
