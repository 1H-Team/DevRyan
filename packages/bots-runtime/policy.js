import {
  BOT_MEMBER_ROLES,
  assertBotBoolean,
  assertBotBoundaryObject,
  assertBotEnum,
  assertBotJsonValue,
  assertBotString,
  hashCanonicalBotJson,
  isPlainBotJsonObject,
} from './contract.js';

export const BOT_CHANNEL_ACL_ROLES = Object.freeze(['reader', 'collaborator']);
export const BOT_POLICY_EFFECTS = Object.freeze(['deny', 'prompt', 'allow']);
export const BOT_RISK_LEVELS = Object.freeze(['low', 'sensitive', 'critical']);
export const BOT_APPROVAL_CLASSES = Object.freeze(['none', 'requester', 'operator', 'manager']);
export const BOT_AUTHORIZATION_OPERATIONS = Object.freeze([
  'read_channel',
  'send_channel',
  'operate_bot',
  'manage_bot',
]);

const approvalClassByRisk = Object.freeze({
  low: 'requester',
  sensitive: 'requester',
  critical: 'requester',
});

const authorizationDecision = (allowed, reason, breakGlass = false) => ({
  allowed,
  reason,
  breakGlass,
});

const assertNullableEnum = (value, values, field) => {
  if (value === null) return null;
  return assertBotEnum(value, values, field);
};

export const authorizeBotOperation = (input) => {
  assertBotBoundaryObject(input, {
    label: 'authorization input',
    required: [
      'operation',
      'actorUserId',
      'ownerUserId',
      'membershipRole',
      'channelAclRole',
      'isGlobalAdmin',
      'breakGlass',
    ],
  });
  const operation = assertBotEnum(
    input.operation,
    BOT_AUTHORIZATION_OPERATIONS,
    'operation',
  );
  const actorUserId = assertBotString(input.actorUserId, 'actorUserId');
  const ownerUserId = assertBotString(input.ownerUserId, 'ownerUserId');
  const membershipRole = assertNullableEnum(input.membershipRole, BOT_MEMBER_ROLES, 'membershipRole');
  const channelAclRole = assertNullableEnum(
    input.channelAclRole,
    BOT_CHANNEL_ACL_ROLES,
    'channelAclRole',
  );
  const isGlobalAdmin = assertBotBoolean(input.isGlobalAdmin, 'isGlobalAdmin');
  const breakGlass = assertBotBoolean(input.breakGlass, 'breakGlass');

  if (operation === 'manage_bot') {
    if (isGlobalAdmin) return authorizationDecision(true, 'global_admin');
    return membershipRole === 'manager'
      ? authorizationDecision(true, 'manager')
      : authorizationDecision(false, 'manager_required');
  }

  if (operation === 'operate_bot') {
    if (isGlobalAdmin) return authorizationDecision(true, 'global_admin');
    return membershipRole !== null
      ? authorizationDecision(true, membershipRole)
      : authorizationDecision(false, 'active_membership_required');
  }

  if (operation === 'read_channel' && isGlobalAdmin && breakGlass) {
    return authorizationDecision(true, 'global_admin_break_glass', true);
  }
  if (membershipRole === null) {
    return authorizationDecision(false, 'active_membership_required');
  }
  if (actorUserId === ownerUserId) {
    return authorizationDecision(true, 'channel_owner');
  }

  if (operation === 'read_channel') {
    return channelAclRole !== null
      ? authorizationDecision(true, `channel_${channelAclRole}`)
      : authorizationDecision(false, 'channel_acl_required');
  }

  return channelAclRole === 'collaborator'
    ? authorizationDecision(true, 'channel_collaborator')
    : authorizationDecision(false, 'channel_collaborator_required');
};

export const resolveBotApprovalClass = (input) => {
  assertBotBoundaryObject(input, {
    label: 'approval resolution input',
    required: ['effect', 'risk'],
  });
  const effect = assertBotEnum(input.effect, BOT_POLICY_EFFECTS, 'effect');
  const risk = assertBotEnum(input.risk, BOT_RISK_LEVELS, 'risk');
  return effect === 'prompt' ? approvalClassByRisk[risk] : 'none';
};

export const canApproveBotAction = (input) => {
  assertBotBoundaryObject(input, {
    label: 'approval input',
    required: [
      'approvalClass',
      'requesterUserId',
      'approverUserId',
      'approverRole',
      'requireDistinctApprover',
    ],
  });
  const approvalClass = assertBotEnum(
    input.approvalClass,
    BOT_APPROVAL_CLASSES,
    'approvalClass',
  );
  const requesterUserId = assertBotString(input.requesterUserId, 'requesterUserId');
  const approverUserId = assertBotString(input.approverUserId, 'approverUserId');
  const approverRole = assertBotEnum(input.approverRole, BOT_MEMBER_ROLES, 'approverRole');
  const requireDistinctApprover = assertBotBoolean(
    input.requireDistinctApprover,
    'requireDistinctApprover',
  );

  if (approvalClass === 'none') return false;
  if (approvalClass === 'requester') {
    return !requireDistinctApprover && requesterUserId === approverUserId;
  }
  // Role names remain accepted for old persisted approvals, but they no longer
  // create a user-facing capability hierarchy. Separation of duties is an
  // explicit action property instead.
  const mustBeDistinct = requireDistinctApprover;
  if (mustBeDistinct && requesterUserId === approverUserId) return false;
  return BOT_MEMBER_ROLES.includes(approverRole);
};

const ACTION_FIELDS = Object.freeze([
  'botId',
  'revisionId',
  'runId',
  'channelId',
  'initiatorUserId',
  'tool',
  'action',
  'target',
  'credentialScopeKey',
  'computerScopeKey',
  'args',
  'limits',
]);

export const validateBotActionDescriptor = (action) => {
  assertBotBoundaryObject(action, {
    label: 'action',
    required: ACTION_FIELDS,
  });
  for (const field of [
    'botId',
    'revisionId',
    'runId',
    'channelId',
    'initiatorUserId',
    'tool',
    'action',
    'computerScopeKey',
  ]) {
    assertBotString(action[field], `action.${field}`);
  }
  assertBotString(action.credentialScopeKey, 'action.credentialScopeKey', { nullable: true });
  for (const field of ['target', 'args', 'limits']) {
    if (!isPlainBotJsonObject(action[field])) {
      throw new TypeError(`action.${field} must be a plain JSON object`);
    }
    assertBotJsonValue(action[field], `action.${field}`);
  }
  return action;
};

export const hashBotAction = (action) => {
  validateBotActionDescriptor(action);
  return `sha256:${hashCanonicalBotJson(action)}`;
};
