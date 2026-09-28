import { describe, expect, test } from 'bun:test';

import type { BotCatalogBackup, BotCatalogStatus } from '@/lib/botsApi';
import {
  botCatalogDiscoveryFailure,
  canCheckHostedBots,
  isBotCatalogRecoveryState,
  resolveBotCatalogAction,
} from './botCatalogPresentation';

const backup: BotCatalogBackup = {
  id: '20260926T010000Z-0000abcd',
  kind: 'daily',
  createdAt: '2026-09-26T01:00:00.000Z',
  verifiedAt: '2026-09-26T01:00:05.000Z',
  schemaHead: '20260926000000_local_identity.sql',
  objectCount: 3,
  bytes: 4096,
};

const status = (overrides: Partial<BotCatalogStatus> = {}): BotCatalogStatus => ({
  state: 'ready',
  code: null,
  schema: null,
  maintenance: null,
  activationHold: null,
  viewerIsOwner: true,
  import: { cloud: null, import: null, pending: false },
  ...overrides,
});

const importState = (phase: string, extra: Record<string, unknown> = {}) => ({
  cloud: { hasBots: true, checkedAt: '2026-09-26T00:00:00.000Z', code: null },
  import: {
    id: 'import', mode: 'merge' as const, phase: phase as never, running: false,
    createdAt: '', updatedAt: '', tables: 0, pages: 0, objects: 0, error: null, result: null, ...extra,
  },
  pending: true,
});

describe('Bot catalog recovery presentation', () => {
  test('offers exactly one control per state, in priority order', () => {
    expect(resolveBotCatalogAction(null, null)).toBeNull();
    expect(resolveBotCatalogAction(status(), [])).toBeNull();
    expect(resolveBotCatalogAction(status({ import: importState('merging', { running: true }) }), [])?.kind)
      .toBe('import_running');
    expect(resolveBotCatalogAction(status({ state: 'maintenance', maintenance: { kind: 'restore', startedAt: '' } }), [])?.kind)
      .toBe('maintenance');
    expect(resolveBotCatalogAction(status({ state: 'recovery_required' }), [backup]))
      .toEqual({ kind: 'restore', backup });
    expect(resolveBotCatalogAction(status({ state: 'recovery_required' }), [])?.kind).toBe('start_empty');
    // Recovery outranks the hold and import notices.
    expect(resolveBotCatalogAction(status({
      state: 'recovery_required',
      activationHold: { reason: 'restore', createdAt: '' },
      import: importState('blocked'),
    }), [backup])?.kind).toBe('restore');
    expect(resolveBotCatalogAction(status({
      activationHold: { reason: 'import', createdAt: '' },
      import: importState('completed'),
    }), [])?.kind).toBe('resume_activation');
    expect(resolveBotCatalogAction(status({ import: importState('blocked') }), [])?.kind).toBe('import_blocked');
    expect(resolveBotCatalogAction(status({
      import: importState('failed', { error: { code: 'bot_import_bot_conflict', message: '2 cloud Bots already exist locally', retryable: false } }),
    }), [])).toEqual({ kind: 'import_failed', code: 'bot_import_bot_conflict', message: '2 cloud Bots already exist locally', retry: false });
    // A changed hosted catalog is retried from a fresh export.
    expect(resolveBotCatalogAction(status({
      import: importState('failed', { error: { code: 'bot_import_source_changed', message: 'The cloud changed', retryable: false } }),
    }), [])).toMatchObject({ kind: 'import_failed', retry: true });
    expect(resolveBotCatalogAction(status({ import: { cloud: null, import: null, pending: true } }), [])?.kind)
      .toBe('import_pending');
  });

  test('never offers owner-only controls to other users', () => {
    expect(resolveBotCatalogAction(status({ state: 'recovery_required', viewerIsOwner: false }), [backup])?.kind)
      .toBe('owner_required');
    expect(resolveBotCatalogAction(status({
      viewerIsOwner: false,
      activationHold: { reason: 'import', createdAt: '' },
    }), [])).toBeNull();
  });

  test('replaces the chat only for recovery and maintenance', () => {
    expect(isBotCatalogRecoveryState({ state: 'database_recovery_required' })).toBe(true);
    expect(isBotCatalogRecoveryState({ state: 'catalog_unavailable', database: { state: 'recovery_required' } })).toBe(true);
    expect(isBotCatalogRecoveryState({ state: 'bots_maintenance', database: { state: 'maintenance' } })).toBe(true);
    expect(isBotCatalogRecoveryState({ state: 'catalog_unavailable', database: { state: 'starting' } })).toBe(false);
    expect(isBotCatalogRecoveryState({ state: 'docker_stopped', database: { state: 'ready' } })).toBe(false);
    expect(isBotCatalogRecoveryState(null)).toBe(false);
  });

  test('explains a hosted project that is over its quota', () => {
    const quota = botCatalogDiscoveryFailure('bot_import_source_quota_exceeded');
    expect(quota.title).toBe('Hosted Project Is Over Its Quota');
    expect(quota.detail).toContain('have not been deleted');
    expect(quota.detail).toContain('check again');
    expect(quota.detail).not.toContain('bot_import_source_quota_exceeded');

    expect(botCatalogDiscoveryFailure('bot_import_source_forbidden').title).toBe('Hosted Project Rejected the Saved Key');
    expect(botCatalogDiscoveryFailure('bot_import_source_unavailable')).toEqual({
      title: 'Could Not Check Hosted Bots',
      detail: 'The hosted source could not be checked (bot_import_source_unavailable).',
    });
  });

  test('offers the hosted check only to the owner of a quiet catalog with a saved source', () => {
    const saved = { sourceConfigured: true, cloud: null, import: null, pending: false };
    const offered = (value: BotCatalogStatus) => canCheckHostedBots(value, resolveBotCatalogAction(value, []));

    // A saved source alone raises no notice: nothing was asked yet.
    expect(resolveBotCatalogAction(status({ import: saved }), [])).toBeNull();
    expect(offered(status({ import: saved }))).toBe(true);
    // A finished or dismissed import stays reachable.
    expect(offered(status({ import: { ...importState('dismissed'), sourceConfigured: true, cloud: null, pending: false } }))).toBe(true);

    expect(offered(status({ import: { ...saved, sourceConfigured: false } }))).toBe(false);
    expect(offered(status())).toBe(false);
    expect(offered(status({ viewerIsOwner: false, import: saved }))).toBe(false);
    expect(offered(status({ state: 'unavailable', import: saved }))).toBe(false);
    // A notice already carries its own control.
    expect(offered(status({ import: { ...saved, pending: true } }))).toBe(false);
    expect(offered(status({
      import: { ...saved, cloud: { hasBots: null, checkedAt: '', code: 'bot_import_source_quota_exceeded' } },
    }))).toBe(false);
    expect(canCheckHostedBots(null, null)).toBe(false);
  });
});
