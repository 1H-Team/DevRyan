import { describe, expect, test } from 'bun:test';

import type { BotRevisionDetail } from '@/lib/botsApi';
import { managementDetail, draftRevision } from './botManagementTestFixtures';
import { defaultBotCapabilityRevision } from './botCapabilityAssignmentsPresentation';

describe('Bot capability assignment presentation', () => {
  test('selects the latest setup configuration before the active revision', () => {
    const detail = managementDetail();
    const olderDraft = { ...draftRevision(), id: 'c0000000-0000-4000-8000-000000000002', revisionNumber: 1 };
    const latestDraft = { ...draftRevision(), id: 'c0000000-0000-4000-8000-000000000003', revisionNumber: 4 };
    const active: BotRevisionDetail = {
      ...draftRevision(),
      id: detail.bot.activeRevisionId || '',
      revisionNumber: 3,
      activatedAt: detail.bot.updatedAt,
    };
    const selected = defaultBotCapabilityRevision({
      ...detail,
      revisions: [active, olderDraft, latestDraft],
    });
    expect(selected?.id).toBe(latestDraft.id);
  });

  test('falls back to the active revision when no setup configuration exists', () => {
    const detail = managementDetail();
    const active: BotRevisionDetail = {
      ...draftRevision(),
      id: detail.bot.activeRevisionId || '',
      activatedAt: detail.bot.updatedAt,
    };
    expect(defaultBotCapabilityRevision({ ...detail, revisions: [active] })?.id).toBe(active.id);
  });
});
