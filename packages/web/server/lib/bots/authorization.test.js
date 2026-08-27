import { describe, expect, it, vi } from 'vitest';

import { createBotAuthorization } from './authorization.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'a0000000-0000-4000-8000-000000000001';
const MEMBER_ID = 'a0000000-0000-4000-8000-000000000002';
const ADMIN_ID = 'a0000000-0000-4000-8000-000000000003';

const principal = (id, role = 'developer') => ({ id, role, scope: 'managed' });

const createStore = ({
  membershipRole = 'member',
  membershipRevoked = false,
  aclRole = null,
  actorId = MEMBER_ID,
} = {}) => ({
  async get(table, filters) {
    if (table === 'bots') return {
      id: BOT_ID,
      lifecycle: 'active',
      tenancy: 'team',
    };
    if (table === 'bot_channels') return filters.id === CHANNEL_ID ? {
      id: CHANNEL_ID,
      bot_id: BOT_ID,
      owner_user_id: OWNER_ID,
      archived_at: null,
    } : null;
    if (table === 'bot_memberships') {
      if (filters.user_id !== actorId || membershipRole === null) return null;
      return {
        bot_id: BOT_ID,
        user_id: actorId,
        role: membershipRole,
        activated_at: '2026-08-22T00:00:00.000Z',
        revoked_at: membershipRevoked ? '2026-08-22T01:00:00.000Z' : null,
      };
    }
    if (table === 'bot_channel_acl' && aclRole) return {
      channel_id: CHANNEL_ID,
      user_id: actorId,
      role: aclRole,
      revoked_at: null,
    };
    return null;
  },
});

describe('Production Bots authorization', () => {
  it('requires active Bot membership even for the private channel owner', async () => {
    const authorization = createBotAuthorization({
      store: createStore({ membershipRole: null, actorId: OWNER_ID }),
    });
    await expect(authorization.requireChannelRead(
      principal(OWNER_ID),
      BOT_ID,
      CHANNEL_ID,
    )).rejects.toMatchObject({ code: 'bot_membership_required', statusCode: 403 });
  });

  it('does not grant Managers implicit transcript access', async () => {
    const authorization = createBotAuthorization({
      store: createStore({ membershipRole: 'manager' }),
    });
    await expect(authorization.requireManager(principal(MEMBER_ID), BOT_ID)).resolves.toBeTruthy();
    await expect(authorization.requireChannelRead(
      principal(MEMBER_ID),
      BOT_ID,
      CHANNEL_ID,
    )).rejects.toMatchObject({ code: 'bot_channel_forbidden' });
  });

  it('allows Readers to read and only Collaborators to send', async () => {
    const reader = createBotAuthorization({
      store: createStore({ membershipRole: 'member', aclRole: 'reader' }),
    });
    await expect(reader.requireChannelRead(principal(MEMBER_ID), BOT_ID, CHANNEL_ID))
      .resolves.toBeTruthy();
    await expect(reader.requireChannelSend(principal(MEMBER_ID), BOT_ID, CHANNEL_ID))
      .rejects.toMatchObject({ code: 'bot_channel_forbidden' });

    const collaborator = createBotAuthorization({
      store: createStore({ membershipRole: 'member', aclRole: 'collaborator' }),
    });
    await expect(collaborator.requireChannelSend(principal(MEMBER_ID), BOT_ID, CHANNEL_ID))
      .resolves.toBeTruthy();
  });

  it('rejects revoked memberships regardless of retained ACL rows', async () => {
    const authorization = createBotAuthorization({
      store: createStore({ membershipRevoked: true, aclRole: 'collaborator' }),
    });
    await expect(authorization.requireChannelRead(principal(MEMBER_ID), BOT_ID, CHANNEL_ID))
      .rejects.toMatchObject({ code: 'bot_membership_required' });
  });

  it('applies the same policy to one authoritative send-context snapshot', async () => {
    const authorization = createBotAuthorization({ store: createStore() });
    const context = {
      bot: { id: BOT_ID, lifecycle: 'active' },
      channel: {
        id: CHANNEL_ID,
        bot_id: BOT_ID,
        owner_user_id: OWNER_ID,
        archived_at: null,
      },
      membership: {
        bot_id: BOT_ID,
        user_id: MEMBER_ID,
        role: 'member',
        activated_at: '2026-08-22T00:00:00.000Z',
        revoked_at: null,
      },
      acl: {
        channel_id: CHANNEL_ID,
        user_id: MEMBER_ID,
        role: 'collaborator',
        revoked_at: null,
      },
    };

    await expect(authorization.requireChannelSendContext(
      principal(MEMBER_ID),
      context,
      CHANNEL_ID,
    )).resolves.toMatchObject({ decision: { allowed: true } });

    await expect(authorization.requireChannelSendContext(
      principal(MEMBER_ID),
      {
        ...context,
        membership: { ...context.membership, revoked_at: '2026-08-22T01:00:00.000Z' },
      },
      CHANNEL_ID,
    )).rejects.toMatchObject({ code: 'bot_membership_required' });
  });

  it('fails closed when joined send-context identities do not agree', async () => {
    const authorization = createBotAuthorization({ store: createStore() });
    await expect(authorization.requireChannelSendContext(
      principal(MEMBER_ID),
      {
        bot: { id: BOT_ID },
        channel: {
          id: CHANNEL_ID,
          bot_id: 'b0000000-0000-4000-8000-000000000099',
          owner_user_id: OWNER_ID,
          archived_at: null,
        },
        membership: null,
        acl: null,
      },
      CHANNEL_ID,
    )).rejects.toMatchObject({ code: 'bot_send_context_invalid', statusCode: 500 });
  });

  it('requires and audits explicit global-admin break glass for private channels', async () => {
    const audit = vi.fn(async () => {});
    const authorization = createBotAuthorization({
      store: createStore({ membershipRole: null, actorId: ADMIN_ID }),
      audit,
    });
    const admin = principal(ADMIN_ID, 'admin');

    await expect(authorization.requireChannelRead(admin, BOT_ID, CHANNEL_ID))
      .rejects.toMatchObject({ code: 'bot_membership_required' });
    await expect(authorization.requireChannelRead(
      admin,
      BOT_ID,
      CHANNEL_ID,
      'INC-421 recovery review',
    )).resolves.toMatchObject({ decision: { breakGlass: true } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      principal: admin,
      botId: BOT_ID,
      targetType: 'bot_channel',
      targetId: CHANNEL_ID,
      action: 'bot.channel.break_glass',
      result: 'success',
      metadata: expect.objectContaining({ reason: 'INC-421 recovery review' }),
    }));
  });
});
