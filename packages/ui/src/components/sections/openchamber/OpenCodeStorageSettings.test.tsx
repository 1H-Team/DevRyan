import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n';
import type { OpenCodeStorageRunSummary, OpenCodeStorageStatus, RuntimeAPIs } from '@/lib/api/types';
import { OpenCodeStorageSettings, OpenCodeStorageSettingsView } from './OpenCodeStorageSettings';

const retentionSource = readFileSync(new URL('./SessionRetentionSettings.tsx', import.meta.url), 'utf8');
const messages = readFileSync(new URL('../../../lib/i18n/messages/en.settings.ts', import.meta.url), 'utf8');

const baseDiagnostics = {
  getStatus: async () => ({ sessionCount: 0, diskBytes: 0 }),
  export: async () => ({ cancelled: true, fileName: '' }),
  sanitizeText: async (text: string) => text,
  clear: async () => ({ sessionCount: 0, diskBytes: 0 }),
};

const renderWithApis = (diagnostics: Record<string, unknown>) => renderToStaticMarkup(
  <RuntimeAPIContext.Provider value={{ runtime: {}, diagnostics } as unknown as RuntimeAPIs}>
    <I18nProvider>
      <OpenCodeStorageSettings />
    </I18nProvider>
  </RuntimeAPIContext.Provider>,
);

const run: OpenCodeStorageRunSummary = {
  at: Date.UTC(2026, 8, 4, 9, 30),
  reason: 'startup',
  dryRun: false,
  status: 'ok',
  durationMs: 1200,
  deletedEvents: 13727,
  deletedOrphanEvents: 13727,
  deletedOrphanSequences: 40,
  prunedEvents: 0,
  prunedSessions: 0,
  candidateSessions: 0,
  orphanEvents: 13727,
  prunableEvents: 0,
  partial: false,
  vacuum: { requested: 'never', decided: false, reason: 'not_requested' },
  vacuumed: false,
  vacuumDurationMs: 0,
  before: { dbBytes: 15_400_000_000, walBytes: 0, pageSize: 4096, pageCount: 3_766_393, freelistPages: 272_039, reclaimableBytes: 1_114_271_744, eventRows: 190_808 },
  after: { dbBytes: 15_400_000_000, walBytes: 0, pageSize: 4096, pageCount: 3_766_393, freelistPages: 300_000, reclaimableBytes: 1_228_800_000, eventRows: 177_081 },
  error: null,
};

const status: OpenCodeStorageStatus = {
  dbPath: '/Users/dev/.local/share/opencode/opencode.db',
  exists: true,
  generation: 1,
  schema: 'ok',
  dbBytes: 15_400_000_000,
  walBytes: 4_000_000,
  reclaimableBytes: 1_228_800_000,
  pageSize: 4096,
  pageCount: 3_766_393,
  freelistPages: 300_000,
  eventRows: 177_081,
  orphanEventRows: 0,
  error: null,
  lastRun: run,
  lastDryRun: null,
  running: false,
  maintenance: { enabled: true, idleHours: 24, keepSeqPerAggregate: 64 },
};

const renderView = (props: Partial<React.ComponentProps<typeof OpenCodeStorageSettingsView>> = {}) => renderToStaticMarkup(
  <I18nProvider>
    <OpenCodeStorageSettingsView
      status={status}
      loading={false}
      error={null}
      dryRun={null}
      busy="idle"
      onDryRun={() => {}}
      {...props}
    />
  </I18nProvider>,
);

// The `disabled` attribute, not the `disabled:` Tailwind variants in the class list.
const buttonStates = (markup: string) => (markup.match(/<button[^>]*>/g) ?? [])
  .map((button) => /\sdisabled(?:=""|(?=[\s>]))/.test(button));

describe('OpenCodeStorageSettings', () => {

  test('renders the section with a loading summary when the storage API exists', () => {
    const markup = renderWithApis({
      ...baseDiagnostics,
      getOpenCodeStorage: async () => status,
      compactOpenCodeStorage: async () => ({ dryRun: true }),
    });
    expect(markup).toContain('data-opencode-storage-settings');
    expect(markup).toContain('OpenCode Storage');
    expect(markup).toContain('Reading OpenCode storage');
    expect(markup).toContain('Dry Run');
    expect(markup).not.toContain('Compact Now');
  });

  test('the view shows size, reclaimable space, event rows and the last run', () => {
    const markup = renderView();
    expect(markup).toContain('14.3 GiB');
    expect(markup).toContain('1.1 GiB reclaimable');
    expect(markup).toContain((177_081).toLocaleString());
    expect(markup).toContain(`removed ${(13727).toLocaleString()} events`);
  });

  test('an OpenCode 1 database is read-only: no automatic cleanup is promised and only Dry Run is offered', () => {
    const never = renderView({ status: { ...status, lastRun: null, maintenance: { ...status.maintenance, enabled: false } } });
    expect(never).toContain('No cleanup has run. DevRyan runs OpenCode 2 and no longer cleans up an OpenCode 1 database');
    expect(never).not.toContain('before every OpenCode launch');
    expect(never).not.toContain('turned off in settings.json');
    expect(never).not.toContain('Compact Now');
    expect(buttonStates(never)).toEqual([false]);

    const orphans = renderView({ status: { ...status, orphanEventRows: 42 } });
    expect(orphans).toContain('42 events belong to deleted sessions');
  });

  test('the view reports a dry run in plain words', () => {
    const dryRun: OpenCodeStorageRunSummary = {
      ...run,
      dryRun: true,
      reason: 'dry_run',
      deletedEvents: 0,
      orphanEvents: 20,
      prunableEvents: 36,
      candidateSessions: 1,
      vacuum: { requested: 'force', decided: false, reason: 'other_opencode_process' },
    };
    const markup = renderView({ dryRun });
    expect(markup).toContain('Dry run: 56 events would be removed (20 from deleted sessions, 36 from 1 idle sessions)');
    expect(markup).toContain('another OpenCode process is running');
  });

  test('the view reports a native OpenCode 2 database as needing no maintenance, with Dry Run off', () => {
    const nativeV2: OpenCodeStorageStatus = {
      ...status,
      dbPath: '/bundle/opencode/opencode.db',
      dbSource: 'selection',
      runtimeGeneration: 2,
      generation: 2,
      schema: 'unknown',
      dbBytes: 12 * 1024 * 1024,
      walBytes: 2 * 1024 * 1024,
      eventRows: 0,
      orphanEventRows: 0,
      error: 'v2_database',
      lastRun: null,
      maintenance: { ...status.maintenance, enabled: false },
    };
    const markup = renderView({ status: nativeV2 });
    expect(markup).toContain('Database 12.0 MiB (+ 2.0 MiB WAL) · OpenCode 2 layout');
    expect(markup).toContain('Cleanup is not needed: OpenCode 2 does not keep the event log');
    expect(markup).not.toContain('not the one DevRyan knows');
    expect(markup).not.toContain('No cleanup has run');
    expect(buttonStates(markup)).toEqual([true]);
  });

  test('an unknown layout, including a kv table without the v2 profile, still fails closed', () => {
    const unknownLayouts: OpenCodeStorageStatus[] = [
      { ...status, generation: 'unknown', schema: 'mismatch', error: 'schema_mismatch: session_context_epoch' },
      { ...status, generation: 2, schema: 'mismatch', error: 'schema_mismatch: session_v2' },
    ];
    for (const unknown of unknownLayouts) {
      const markup = renderView({ status: unknown });
      expect(markup).toContain('not the one DevRyan knows');
      expect(markup).not.toContain('OpenCode 2 layout');
      expect(buttonStates(markup)).toEqual([true]);
    }
  });

  test('is mounted by the Data Retention section and its copy lives in the storage namespace', () => {
    expect(retentionSource).toContain("import { OpenCodeStorageSettings } from './OpenCodeStorageSettings';");
    expect(retentionSource).toContain('<OpenCodeStorageSettings />');
    expect(messages).toContain("'settings.openchamber.storage.title': 'OpenCode Storage'");
    expect(messages).toContain("'settings.openchamber.storage.actions.dryRun': 'Dry Run'");
    expect(messages).not.toContain("'settings.openchamber.storage.actions.compact'");
  });
});
