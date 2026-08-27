import type {
  BotManagementDetail,
  BotRevisionDetail,
  BotRevisionSummary,
} from '@/lib/botsApi';

type CapabilityRevision = BotRevisionSummary | BotRevisionDetail;

const latestSetupFor = (detail: BotManagementDetail): CapabilityRevision | null => (
  [...detail.revisions]
    .filter((revision) => revision.activatedAt === null && revision.retiredAt === null)
    .sort((left, right) => right.revisionNumber - left.revisionNumber)[0] || null
);

const activeRevisionFor = (detail: BotManagementDetail): CapabilityRevision | null => (
  detail.revisions.find((revision) => revision.id === detail.bot.activeRevisionId) || null
);

export const defaultBotCapabilityRevision = (
  detail: BotManagementDetail,
): CapabilityRevision | null => latestSetupFor(detail) || activeRevisionFor(detail);
