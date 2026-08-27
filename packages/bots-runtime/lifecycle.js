import {
  BOT_LIFECYCLES,
  assertBotBoundaryObject,
  assertBotEnum,
  assertBotJsonValue,
  assertBotString,
  assertBotTimestamp,
  canonicalizeBotJson,
  isPlainBotJsonObject,
} from './contract.js';

const LIFECYCLE_TRANSITIONS = Object.freeze({
  draft: new Set(['active']),
  active: new Set(['paused', 'retired']),
  paused: new Set(['active', 'retired']),
  retired: new Set(),
});

const REVISION_FIELDS = Object.freeze([
  'revisionId',
  'botId',
  'revisionNumber',
  'contract',
  'compiledHash',
  'createdBy',
  'createdAt',
  'activatedAt',
  'retiredAt',
]);

const REVISION_IDENTITY_FIELDS = Object.freeze([
  'revisionId',
  'botId',
  'revisionNumber',
  'createdBy',
  'createdAt',
]);

export const canTransitionBotLifecycle = (from, to) => (
  BOT_LIFECYCLES.includes(from)
  && BOT_LIFECYCLES.includes(to)
  && (from === to || LIFECYCLE_TRANSITIONS[from].has(to))
);

export const assertBotLifecycleTransition = (input) => {
  assertBotBoundaryObject(input, {
    label: 'lifecycle transition input',
    required: ['from', 'to'],
  });
  const from = assertBotEnum(input.from, BOT_LIFECYCLES, 'from');
  const to = assertBotEnum(input.to, BOT_LIFECYCLES, 'to');
  if (!canTransitionBotLifecycle(from, to)) {
    throw new Error(`invalid Bot lifecycle transition: ${from} -> ${to}`);
  }
  return to;
};

export const validateBotRevisionRecord = (revision) => {
  assertBotBoundaryObject(revision, {
    label: 'revision',
    required: REVISION_FIELDS,
  });
  assertBotString(revision.revisionId, 'revision.revisionId');
  assertBotString(revision.botId, 'revision.botId');
  if (!Number.isSafeInteger(revision.revisionNumber) || revision.revisionNumber < 1) {
    throw new TypeError('revision.revisionNumber must be a positive safe integer');
  }
  if (!isPlainBotJsonObject(revision.contract)) {
    throw new TypeError('revision.contract must be a plain JSON object');
  }
  assertBotJsonValue(revision.contract, 'revision.contract');
  if (typeof revision.compiledHash !== 'string' || !/^[a-f0-9]{64}$/.test(revision.compiledHash)) {
    throw new TypeError('revision.compiledHash must be a lowercase SHA-256 hex digest');
  }
  assertBotString(revision.createdBy, 'revision.createdBy');
  assertBotTimestamp(revision.createdAt, 'revision.createdAt');
  assertBotTimestamp(revision.activatedAt, 'revision.activatedAt', { nullable: true });
  assertBotTimestamp(revision.retiredAt, 'revision.retiredAt', { nullable: true });

  if (revision.activatedAt !== null && revision.activatedAt < revision.createdAt) {
    throw new TypeError('revision.activatedAt cannot precede revision.createdAt');
  }
  if (revision.retiredAt !== null) {
    if (revision.activatedAt === null) {
      throw new TypeError('revision.retiredAt requires an activated revision');
    }
    if (revision.retiredAt < revision.activatedAt) {
      throw new TypeError('revision.retiredAt cannot precede revision.activatedAt');
    }
  }
  return revision;
};

export const assertBotRevisionUpdate = (previous, next) => {
  validateBotRevisionRecord(previous);
  validateBotRevisionRecord(next);

  for (const field of REVISION_IDENTITY_FIELDS) {
    if (!Object.is(previous[field], next[field])) {
      throw new Error(`${field} is immutable`);
    }
  }

  if (previous.activatedAt !== null) {
    if (next.activatedAt !== previous.activatedAt) {
      throw new Error('revision activation metadata is immutable once set');
    }
    if (
      previous.compiledHash !== next.compiledHash
      || canonicalizeBotJson(previous.contract) !== canonicalizeBotJson(next.contract)
    ) {
      throw new Error('activated revision content is immutable');
    }
    if (previous.retiredAt !== null && next.retiredAt !== previous.retiredAt) {
      throw new Error('revision retirement metadata is immutable once set');
    }
  } else if (next.retiredAt !== null) {
    throw new Error('Draft revision cannot be retired');
  }

  return next;
};
