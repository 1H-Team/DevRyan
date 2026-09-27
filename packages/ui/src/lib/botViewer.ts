import type { BotSummary } from './botsApi';

// The identity the viewer acts as for one Bot. A workstation owner acts as
// the verified source owner for Bots imported from a hosted catalog, so
// ownership (owner channels, control leases, approvals, own messages) is
// compared per Bot, never against one global principal id.
export const botViewerId = (
  bot: Pick<BotSummary, 'viewerUserId'> | null | undefined,
  principalId: string | null,
): string | null => (
  typeof bot?.viewerUserId === 'string' && bot.viewerUserId ? bot.viewerUserId : principalId
);
