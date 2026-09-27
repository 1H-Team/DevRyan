import { describe, expect, test } from 'bun:test';

import type { BotCatalogBackup, BotCatalogStatus } from '@/lib/botsApi';
import { isBotCatalogRecoveryState, resolveBotCatalogAction } from './botCatalogPresentation';

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
});
