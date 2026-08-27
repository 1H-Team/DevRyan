import { IANAZone } from 'luxon';

import { validateBoundedString, validateUuid } from './validation.js';
import { validateBotRoutineContract } from './routine-runtime.js';

const MAX_DRAFT_OUTPUT_BYTES = 128 * 1024;

const stringArray = (maxItems, maxLength = 512, minItems = 0) => Object.freeze({
  type: 'array',
  minItems,
  maxItems,
  uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength },
});

export const BOT_ROUTINE_DRAFT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'rationale',
    'trigger',
    'timezone',
    'goal',
    'inputs',
    'allowedTools',
    'allowedAccountIds',
    'allowedOrigins',
    'limits',
    'approvalClass',
    'timeoutSeconds',
    'missedPolicy',
    'missedRunCap',
    'completionCriteria',
  ],
  properties: {
    version: { type: 'integer', const: 1 },
    rationale: { type: 'string', minLength: 1, maxLength: 8_192 },
    trigger: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'time'],
          properties: {
            kind: { const: 'daily' },
            time: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'time', 'weekdays'],
          properties: {
            kind: { const: 'weekly' },
            time: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
            weekdays: {
              type: 'array', minItems: 1, maxItems: 7, uniqueItems: true,
              items: { type: 'integer', minimum: 1, maximum: 7 },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'expression'],
          properties: {
            kind: { const: 'cron' },
            expression: { type: 'string', minLength: 9, maxLength: 160 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'localDateTime'],
          properties: {
            kind: { const: 'once' },
            localDateTime: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d$',
            },
          },
        },
      ],
    },
    timezone: { type: 'string', minLength: 1, maxLength: 120 },
    goal: { type: 'string', minLength: 1, maxLength: 16_384 },
    inputs: { type: 'object', additionalProperties: true },
    allowedTools: stringArray(64, 120),
    allowedAccountIds: stringArray(64, 64),
    allowedOrigins: stringArray(64, 2_048),
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['maxActions', 'maxExternalWrites'],
      properties: {
        maxActions: { type: 'integer', minimum: 1, maximum: 100 },
        maxExternalWrites: { type: 'integer', minimum: 0, maximum: 100 },
      },
    },
    approvalClass: { type: 'string', enum: ['none', 'requester'] },
    timeoutSeconds: { type: 'integer', minimum: 60, maximum: 3_600 },
    missedPolicy: { type: 'string', enum: ['skip', 'run_once', 'replay_capped'] },
    missedRunCap: { type: 'integer', minimum: 1, maximum: 3 },
    completionCriteria: stringArray(16, 1_024, 1),
  },
});

export class BotRoutineDrafterError extends Error {
  constructor(message, code = 'bot_routine_draft_invalid', statusCode = 422) {
    super(message);
    this.name = 'BotRoutineDrafterError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotRoutineDrafterError(message, code, statusCode);
};

const parseOutput = (output) => {
  if (output && typeof output === 'object' && !Array.isArray(output)) return structuredClone(output);
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_DRAFT_OUTPUT_BYTES) {
    fail('Routine drafting returned invalid output');
  }
  try {
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed;
  } catch {
    fail('Routine drafting did not return valid JSON');
  }
};

export const buildBotRoutineDraftPrompt = ({ botId, rationale, timezone } = {}) => {
  const normalizedBotId = validateUuid(botId, 'botId');
  const normalizedRationale = validateBoundedString(rationale, 'rationale', { maximum: 8_192 });
  const normalizedTimezone = validateBoundedString(timezone, 'timezone', { maximum: 120 });
  if (!IANAZone.isValidZone(normalizedTimezone)) fail('Routine timezone is invalid', 'bot_routine_timezone_invalid', 400);
  return [
    'Draft one executable Production Bot routine from the Manager rationale below.',
    'Return JSON matching the supplied schema exactly. Do not call tools or perform actions.',
    'Natural-language rationale is context only; every executable permission must appear in the structured fields.',
    'Use the supplied IANA timezone exactly. Prefer a daily/weekly/once trigger; use five-field cron only when necessary.',
    'Use an empty allowed list rather than inventing tools, accounts, or origins.',
    'If maxExternalWrites is greater than zero, choose at least requester approval, default missedPolicy to run_once, and require a fresh approval after recovery.',
    'Keep replay capped at three and choose measurable completion criteria.',
    `Bot ID: ${normalizedBotId}`,
    `Timezone: ${normalizedTimezone}`,
    `Manager rationale:\n${normalizedRationale}`,
  ].join('\n\n');
};

export function createBotRoutineDrafter({ generateNoTools } = {}) {
  if (typeof generateNoTools !== 'function') {
    throw new TypeError('Bot routine drafter is misconfigured');
  }
  return Object.freeze({
    async draft({ principal, botId, rationale, timezone } = {}) {
      if (!principal?.id) fail('Routine drafting requires a Manager', 'bot_manager_required', 403);
      const normalizedRationale = validateBoundedString(rationale, 'rationale', { maximum: 8_192 });
      const normalizedTimezone = validateBoundedString(timezone, 'timezone', { maximum: 120 });
      const output = await generateNoTools({
        principal,
        botId: validateUuid(botId, 'botId'),
        prompt: buildBotRoutineDraftPrompt({ botId, rationale, timezone }),
        schema: BOT_ROUTINE_DRAFT_SCHEMA,
        title: 'Bot Routine Draft',
        system: 'Draft structured routine JSON only. Do not call tools or perform actions.',
      });
      const parsed = parseOutput(output);
      parsed.rationale = normalizedRationale;
      parsed.timezone = normalizedTimezone;
      const contract = validateBotRoutineContract(parsed);
      return Object.freeze({ contract, requiresManagerReview: true });
    },
  });
}
