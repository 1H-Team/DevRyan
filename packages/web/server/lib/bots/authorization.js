import { authorizeBotOperation } from '../../../../bots-runtime/policy.js';

import { validateBreakGlassReason, validateUuid } from './validation.js';

export class BotAuthorizationError extends Error {
  constructor(message, code = 'bot_channel_forbidden', statusCode = 403) {
    super(message);
    this.name = 'BotAuthorizationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const denial = Object.freeze({
  active_membership_required: ['Active Bot membership is required', 'bot_membership_required'],
  manager_required: ['Bot Manager access is required', 'bot_manager_required'],
  operator_required: ['Bot Operator access is required', 'bot_operator_required'],
  channel_acl_required: ['Channel access is required', 'bot_channel_forbidden'],
  channel_collaborator_required: ['Channel Collaborator access is required', 'bot_channel_forbidden'],
});

const activeAt = (row, now) => Boolean(
  row
  && row.revoked_at === null
  && (!row.activated_at || Date.parse(row.activated_at) <= now),
);

const defaultPrincipalPolicy = Object.freeze({
  isGlobalAdmin: (principal) => (
    principal?.role === 'admin'
    && (principal?.scope === 'managed' || principal?.scope === 'local-admin')
  ),
});

export function createBotAuthorization({
  store,
  audit = async () => {},
  principalPolicy = defaultPrincipalPolicy,
  now = () => Date.now(),
} = {}) {
  if (!store || typeof store.get !== 'function') {
    throw new TypeError('Bot authorization requires a store');
  }

  const loadBot = async (botId) => {
    const bot = await store.get('bots', { id: validateUuid(botId, 'botId') });
    if (!bot) throw new BotAuthorizationError('Bot not found', 'bot_not_found', 404);
    return bot;
  };

  const loadMembership = async (botId, principal) => {
    if (!principal?.id) return null;
    const membership = await store.get('bot_memberships', {
      bot_id: botId,
      user_id: principal.id,
    });
    return activeAt(membership, now()) ? membership : null;
  };

  const loadChannel = async (botId, channelId) => {
    const channel = await store.get('bot_channels', {
      id: validateUuid(channelId, 'channelId'),
      bot_id: botId,
    });
    if (!channel || channel.archived_at !== null) {
      throw new BotAuthorizationError('Channel not found', 'bot_channel_not_found', 404);
    }
    return channel;
  };

  const loadAcl = async (channel, principal) => {
    if (!principal?.id || channel.owner_user_id === principal.id) return null;
    const acl = await store.get('bot_channel_acl', {
      channel_id: channel.id,
      user_id: principal.id,
    });
    return acl?.revoked_at === null ? acl : null;
  };

  const authorizeRecords = async ({
    principal,
    operation,
    bot,
    membership = null,
    channel = null,
    acl = null,
    breakGlassReason = null,
  }) => {
    if (!principal?.id) {
      throw new BotAuthorizationError('Authentication required', 'bot_authentication_required', 401);
    }
    if (!bot) throw new BotAuthorizationError('Bot not found', 'bot_not_found', 404);
    if ((operation.startsWith('read_') || operation.startsWith('send_')) && !channel) {
      throw new BotAuthorizationError('Channel is required', 'bot_channel_not_found', 404);
    }
    const isGlobalAdmin = principalPolicy?.isGlobalAdmin?.(principal) === true;
    const wantsBreakGlass = breakGlassReason !== null && breakGlassReason !== undefined;
    const normalizedReason = wantsBreakGlass ? validateBreakGlassReason(breakGlassReason) : null;
    if (wantsBreakGlass && !isGlobalAdmin) {
      throw new BotAuthorizationError('Global administrator access is required', 'bot_channel_forbidden', 403);
    }

    const decision = authorizeBotOperation({
      operation,
      actorUserId: principal.id,
      ownerUserId: channel?.owner_user_id || principal.id,
      membershipRole: membership?.role || null,
      channelAclRole: acl?.role || null,
      isGlobalAdmin,
      breakGlass: wantsBreakGlass,
    });
    if (!decision.allowed) {
      const [message, code] = denial[decision.reason] || ['Bot access is forbidden', 'bot_channel_forbidden'];
      throw new BotAuthorizationError(message, code, 403);
    }

    if (decision.breakGlass) {
      await audit({
        principal,
        botId: bot.id,
        targetType: 'bot_channel',
        targetId: channel.id,
        action: 'bot.channel.break_glass',
        result: 'success',
        metadata: {
          reason: normalizedReason,
          channelOwnerUserId: channel.owner_user_id,
        },
      });
    }

    return Object.freeze({ bot, membership, channel, acl, decision });
  };

  const authorize = async ({
    principal,
    botId,
    operation,
    channelId = null,
    breakGlassReason = null,
  }) => {
    if (!principal?.id) {
      throw new BotAuthorizationError('Authentication required', 'bot_authentication_required', 401);
    }
    const bot = await loadBot(botId);
    const membership = await loadMembership(bot.id, principal);
    const channel = channelId ? await loadChannel(bot.id, channelId) : null;
    if (operation.startsWith('read_') || operation.startsWith('send_')) {
      if (!channel) throw new BotAuthorizationError('Channel is required', 'bot_channel_not_found', 404);
    }
    const acl = channel ? await loadAcl(channel, principal) : null;
    return authorizeRecords({
      principal,
      operation,
      bot,
      membership,
      channel,
      acl,
      breakGlassReason,
    });
  };

  const requireChannelSendContext = async (principal, context, channelId) => {
    if (!principal?.id) {
      throw new BotAuthorizationError('Authentication required', 'bot_authentication_required', 401);
    }
    const normalizedChannelId = validateUuid(channelId, 'channelId');
    if (!context) {
      throw new BotAuthorizationError('Channel not found', 'bot_channel_not_found', 404);
    }
    const { bot, channel } = context;
    const membership = activeAt(context.membership, now()) ? context.membership : null;
    const acl = context.acl?.revoked_at === null ? context.acl : null;
    const valid = bot && channel
      && channel.id === normalizedChannelId
      && channel.bot_id === bot.id
      && channel.archived_at === null
      && (!membership || (membership.bot_id === bot.id && membership.user_id === principal.id))
      && (!acl || (acl.channel_id === channel.id && acl.user_id === principal.id));
    if (!valid) {
      throw new BotAuthorizationError('Bot send context is invalid', 'bot_send_context_invalid', 500);
    }
    return authorizeRecords({
      principal,
      operation: 'send_channel',
      bot,
      membership,
      channel,
      acl,
    });
  };

  const requireActiveMembership = async (principal, botId) => {
    if (!principal?.id) {
      throw new BotAuthorizationError('Authentication required', 'bot_authentication_required', 401);
    }
    const bot = await loadBot(botId);
    const membership = await loadMembership(bot.id, principal);
    if (!membership) {
      throw new BotAuthorizationError(
        'Active Bot membership is required',
        'bot_membership_required',
        403,
      );
    }
    return { bot, membership };
  };

  return Object.freeze({
    authorize,
    requireMembership: requireActiveMembership,
    requireActiveMembership,
    requireOperator: (principal, botId) => authorize({ principal, botId, operation: 'operate_bot' }),
    requireManager: (principal, botId) => authorize({ principal, botId, operation: 'manage_bot' }),
    requireChannelRead: (principal, botId, channelId, breakGlassReason = null) => authorize({
      principal,
      botId,
      channelId,
      operation: 'read_channel',
      breakGlassReason,
    }),
    requireChannelSend: (principal, botId, channelId) => authorize({
      principal,
      botId,
      channelId,
      operation: 'send_channel',
    }),
    requireChannelSendContext,
  });
}
