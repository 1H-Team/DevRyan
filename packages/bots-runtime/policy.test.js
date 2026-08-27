import { describe, expect, test } from 'bun:test';

import {
  BOT_APPROVAL_CLASSES,
  BOT_CHANNEL_ACL_ROLES,
  BOT_POLICY_EFFECTS,
  BOT_RISK_LEVELS,
  authorizeBotOperation,
  canApproveBotAction,
  hashBotAction,
  resolveBotApprovalClass,
} from './policy.js';

const authorizationInput = (overrides = {}) => ({
  operation: 'read_channel',
  actorUserId: 'user-owner',
  ownerUserId: 'user-owner',
  membershipRole: 'member',
  channelAclRole: null,
  isGlobalAdmin: false,
  breakGlass: false,
  ...overrides,
});

const action = (overrides = {}) => ({
  botId: 'bot-1',
  revisionId: 'revision-1',
  runId: 'run-1',
  channelId: 'channel-1',
  initiatorUserId: 'user-1',
  tool: 'browser',
  action: 'click',
  target: { origin: 'https://example.com', ref: 'btn-submit' },
  credentialScopeKey: null,
  computerScopeKey: 'bot:bot-1',
  args: { ref: 'btn-submit', button: 'left' },
  limits: { maxAttempts: 1 },
  ...overrides,
});

describe('Bot role and channel ACL decisions', () => {
  test('keeps transcripts owner-private unless an active member has an ACL', () => {
    expect(authorizeBotOperation(authorizationInput())).toEqual({
      allowed: true,
      reason: 'channel_owner',
      breakGlass: false,
    });
    expect(authorizeBotOperation(authorizationInput({
      actorUserId: 'user-manager',
      membershipRole: 'manager',
    }))).toEqual({
      allowed: false,
      reason: 'channel_acl_required',
      breakGlass: false,
    });
    expect(authorizeBotOperation(authorizationInput({
      actorUserId: 'user-reader',
      membershipRole: 'member',
      channelAclRole: 'reader',
    })).allowed).toBe(true);
    expect(authorizeBotOperation(authorizationInput({
      operation: 'send_channel',
      actorUserId: 'user-reader',
      membershipRole: 'member',
      channelAclRole: 'reader',
    })).allowed).toBe(false);
    expect(authorizeBotOperation(authorizationInput({
      operation: 'send_channel',
      actorUserId: 'user-collaborator',
      membershipRole: 'member',
      channelAclRole: 'collaborator',
    })).allowed).toBe(true);
  });

  test('separates membership operations from transcript ACLs and audits break-glass', () => {
    expect(authorizeBotOperation(authorizationInput({
      operation: 'operate_bot',
      actorUserId: 'operator',
      membershipRole: 'operator',
    })).allowed).toBe(true);
    expect(authorizeBotOperation(authorizationInput({
      operation: 'manage_bot',
      actorUserId: 'manager',
      membershipRole: 'manager',
    })).allowed).toBe(true);
    expect(authorizeBotOperation(authorizationInput({
      actorUserId: 'admin',
      membershipRole: null,
      isGlobalAdmin: true,
    })).allowed).toBe(false);
    expect(authorizeBotOperation(authorizationInput({
      actorUserId: 'admin',
      membershipRole: null,
      isGlobalAdmin: true,
      breakGlass: true,
    }))).toEqual({
      allowed: true,
      reason: 'global_admin_break_glass',
      breakGlass: true,
    });
  });

  test('rejects unknown authorization fields', () => {
    expect(() => authorizeBotOperation(authorizationInput({ role: 'manager' })))
      .toThrow('authorization input contains unknown field role');
  });
});

describe('Bot action policy contract', () => {
  test('publishes policy, risk, ACL, and approval enums', () => {
    expect(BOT_CHANNEL_ACL_ROLES).toEqual(['reader', 'collaborator']);
    expect(BOT_POLICY_EFFECTS).toEqual(['deny', 'prompt', 'allow']);
    expect(BOT_RISK_LEVELS).toEqual(['low', 'sensitive', 'critical']);
    expect(BOT_APPROVAL_CLASSES).toEqual(['none', 'requester', 'operator', 'manager']);
  });

  test('maps every prompted risk to a simple requester confirmation', () => {
    expect(resolveBotApprovalClass({ effect: 'allow', risk: 'critical' })).toBe('none');
    expect(resolveBotApprovalClass({ effect: 'deny', risk: 'low' })).toBe('none');
    expect(resolveBotApprovalClass({ effect: 'prompt', risk: 'low' })).toBe('requester');
    expect(resolveBotApprovalClass({ effect: 'prompt', risk: 'sensitive' })).toBe('requester');
    expect(resolveBotApprovalClass({ effect: 'prompt', risk: 'critical' })).toBe('requester');
  });

  test('keeps requester confirmation simple and treats legacy roles equally', () => {
    expect(canApproveBotAction({
      approvalClass: 'requester',
      requesterUserId: 'user-1',
      approverUserId: 'user-1',
      approverRole: 'member',
      requireDistinctApprover: false,
    })).toBe(true);
    expect(canApproveBotAction({
      approvalClass: 'operator',
      requesterUserId: 'user-1',
      approverUserId: 'user-1',
      approverRole: 'manager',
      requireDistinctApprover: true,
    })).toBe(false);
    expect(canApproveBotAction({
      approvalClass: 'operator',
      requesterUserId: 'user-1',
      approverUserId: 'user-2',
      approverRole: 'manager',
      requireDistinctApprover: true,
    })).toBe(true);
    expect(canApproveBotAction({
      approvalClass: 'manager',
      requesterUserId: 'user-1',
      approverUserId: 'user-2',
      approverRole: 'operator',
      requireDistinctApprover: false,
    })).toBe(true);
  });

  test('hashes the exact canonical action and rejects wider boundary shapes', () => {
    const hash = hashBotAction(action());
    const reordered = action({
      args: { button: 'left', ref: 'btn-submit' },
      target: { ref: 'btn-submit', origin: 'https://example.com' },
    });

    expect(hash).toBe('sha256:b2e69bce4e83f7c46a3313c9f1fb12356ce8ef927db8441fac2cac12509dc8e5');
    expect(hashBotAction(reordered)).toBe(hash);
    expect(hashBotAction(action({ args: { ref: 'btn-submit', button: 'right' } }))).not.toBe(hash);
    expect(hashBotAction(action({ revisionId: 'revision-2' }))).not.toBe(hash);
    expect(() => hashBotAction(action({ plaintextCredential: 'secret' })))
      .toThrow('action contains unknown field plaintextCredential');
  });
});
