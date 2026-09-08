import type { BotAssignedCatalog, BotMembershipSummary, BotRevisionSummary, BotSummary } from './botsApi';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const hasString = (record: Record<string, unknown>, key: string): boolean => (
  typeof record[key] === 'string'
);

const hasNullableString = (record: Record<string, unknown>, key: string): boolean => (
  record[key] === null || typeof record[key] === 'string'
);

const nullableStringOr = (value: unknown, fallback: string | null): string | null => {
  if (value === null) return null;
  return typeof value === 'string' ? value : fallback;
};

export const parseBot = (value: unknown, previous?: BotSummary): BotSummary | null => {
  if (!isRecord(value)) return null;
  if (!hasString(value, 'id')
    || !hasString(value, 'name')
    || !['draft', 'active', 'paused', 'retired'].includes(String(value.lifecycle))
    || !['team', 'personalized'].includes(String(value.tenancy))
    || !hasNullableString(value, 'activeRevisionId')
    || !hasString(value, 'createdAt')
    || !hasString(value, 'updatedAt')
    || !hasNullableString(value, 'retiredAt')
    || (value.title !== undefined && typeof value.title !== 'string')
    || (value.summary !== undefined && typeof value.summary !== 'string')
    || (value.avatarUrl !== undefined && !hasNullableString(value, 'avatarUrl'))
    || (value.avatarFallback !== undefined && !hasNullableString(value, 'avatarFallback'))) return null;
  return {
    id: String(value.id),
    name: String(value.name),
    title: typeof value.title === 'string' ? value.title : previous?.title ?? String(value.name),
    summary: typeof value.summary === 'string' ? value.summary : previous?.summary ?? '',
    avatarUrl: nullableStringOr(value.avatarUrl, previous?.avatarUrl ?? null),
    avatarFallback: nullableStringOr(value.avatarFallback, previous?.avatarFallback ?? null),
    lifecycle: value.lifecycle as BotSummary['lifecycle'],
    tenancy: value.tenancy as BotSummary['tenancy'],
    activeRevisionId: value.activeRevisionId as string | null,
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    retiredAt: value.retiredAt as string | null,
  };
};

export const isRevision = (value: unknown): value is BotRevisionSummary => {
  if (!isRecord(value)) return false;
  return hasString(value, 'id')
    && hasString(value, 'botId')
    && Number.isSafeInteger(value.revisionNumber)
    && hasString(value, 'compiledHash')
    && hasString(value, 'createdAt')
    && hasNullableString(value, 'activatedAt')
    && hasNullableString(value, 'retiredAt');
};

export const isMembership = (value: unknown): value is BotMembershipSummary => {
  if (!isRecord(value)) return false;
  return hasString(value, 'botId')
    && hasString(value, 'userId')
    && hasString(value, 'role')
    && hasString(value, 'activatedAt')
    && hasNullableString(value, 'revokedAt')
    && hasString(value, 'updatedAt');
};

// HTTP bootstrap requires all three collections. Missing data must not be
// mistaken for an authoritative empty catalog.
export const parseBotAssignedCatalog = (value: unknown): BotAssignedCatalog | null => {
  if (!isRecord(value) || !Array.isArray(value.bots)
    || !Array.isArray(value.revisions) || !value.revisions.every(isRevision)
    || !Array.isArray(value.memberships) || !value.memberships.every(isMembership)) return null;
  const bots: BotSummary[] = [];
  for (const entry of value.bots) {
    const bot = parseBot(entry);
    if (!bot) return null;
    bots.push(bot);
  }
  return { bots, revisions: value.revisions, memberships: value.memberships };
};
