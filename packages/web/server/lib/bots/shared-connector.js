import {
  assertExactObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TRANSPORT_UNCERTAIN_CODES = new Set([
  'bot_runtime_supervisor_unavailable',
  'bot_runtime_supervisor_request_failed',
  'bot_runtime_supervisor_response_invalid',
  'bot_supervisor_docker_api_error',
  'bot_supervisor_docker_unavailable',
]);

export class BotSharedConnectorError extends Error {
  constructor(message, code = 'bot_shared_publication_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotSharedConnectorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotSharedConnectorError(message, code, statusCode);
};

const normalizePublication = (target, args) => {
  let bytes = null;
  try {
    assertExactObject(target, {
      label: 'Bot Shared publication target',
      required: ['filename', 'contentType', 'goal'],
      optional: ['operationKind'],
    });
    assertExactObject(args, {
      label: 'Bot Shared publication arguments',
      required: ['contentBase64'],
    });
    if (target.operationKind !== undefined && target.operationKind !== 'write') {
      fail('Bot Shared publication operation kind is invalid');
    }
    const filename = validateBoundedString(target.filename, 'filename', { maximum: 255 });
    const contentType = validateBoundedString(target.contentType, 'contentType', {
      maximum: 255,
      pattern: /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/,
    });
    const contentBase64 = validateBoundedString(args.contentBase64, 'contentBase64', {
      maximum: 48 * 1024,
      pattern: BASE64_PATTERN,
    });
    bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.byteLength < 1 || bytes.byteLength > 36 * 1024
      || bytes.toString('base64') !== contentBase64) {
      fail('Bot Shared publication content is invalid');
    }
    return Object.freeze({ filename, contentType, contentBase64, bytes });
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof BotSharedConnectorError) throw error;
    fail(error.message);
  }
};

export function createBotSharedConnector({ sharedFileService } = {}) {
  if (!sharedFileService || typeof sharedFileService.publishBotFile !== 'function') {
    throw new TypeError('Bot Shared connector is misconfigured');
  }
  return Object.freeze({
    id: 'shared',
    async describeActions() {
      return Object.freeze([{
        name: 'publish',
        operationKind: 'write',
        description: 'Explicitly publish one bounded file to the current conversation Shared folder.',
      }]);
    },
    async validate(input) {
      if (input?.action !== 'publish') {
        fail('Bot Shared action is unavailable', 'bot_shared_action_unavailable', 403);
      }
      const publication = normalizePublication(input.target, input.args);
      publication.bytes.fill(0);
      return Object.freeze({
        target: Object.freeze({
          filename: publication.filename,
          contentType: publication.contentType,
          goal: 'Publish this file to the current conversation Shared folder',
        }),
        args: Object.freeze({ contentBase64: publication.contentBase64 }),
        operationKind: 'write',
      });
    },
    async authorize(input) {
      if (input?.action?.tool !== 'connector:shared'
        || input.action.action !== 'publish'
        || input?.policyDecision?.operationKind !== 'write') {
        fail('Bot Shared authorization is invalid', 'bot_shared_authorization_invalid', 403);
      }
      return Object.freeze({ authorized: true });
    },
    async execute(input) {
      const publication = normalizePublication(input?.target, input?.args);
      try {
        const sharedFile = await sharedFileService.publishBotFile({
          botId: validateUuid(input?.botId, 'botId'),
          channelId: validateUuid(input?.channelId, 'channelId'),
          runId: validateUuid(input?.runId, 'runId'),
          principalId: validateUuid(input?.principalId, 'principalId'),
          filename: publication.filename,
          contentType: publication.contentType,
          bytes: publication.bytes,
        });
        return Object.freeze({
          result: Object.freeze({ sharedFile }),
          connectorReceipt: Object.freeze({
            nativeExactlyOnce: false,
            writeGuarantee: 'durable_shared_mapping',
          }),
        });
      } catch (error) {
        if (TRANSPORT_UNCERTAIN_CODES.has(error?.code) && error && typeof error === 'object') {
          error.transportUncertain = true;
        }
        throw error;
      } finally {
        publication.bytes.fill(0);
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
