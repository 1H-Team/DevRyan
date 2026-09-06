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
  managedRuntime: true,
  compactionPending: false,
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
      onCompact={() => {}}
      {...props}
    />
  </I18nProvider>,
);

describe('OpenCodeStorageSettings', () => {

  test('renders the section with a loading summary when the storage API exists', () => {
    const markup = renderWithApis({
      ...baseDiagnostics,
      getOpenCodeStorage: async () => status,
      compactOpenCodeStorage: async () => ({ scheduled: true }),
    });
    expect(markup).toContain('data-opencode-storage-settings');
    expect(markup).toContain('OpenCode Storage');
    expect(markup).toContain('Reading OpenCode storage');
    expect(markup).toContain('Dry Run');
    expect(markup).toContain('Compact Now');
  });

  test('the view shows size, reclaimable space, event rows and the last run', () => {
    const markup = renderView();
    expect(markup).toContain('14.3 GiB');
    expect(markup).toContain('1.1 GiB reclaimable');
    expect(markup).toContain((177_081).toLocaleString());
    expect(markup).toContain(`removed ${(13727).toLocaleString()} events`);
    expect(markup).not.toContain('turned off in settings.json');
    expect(markup).not.toContain('only available for the OpenCode runtime');
  });

  test('the view explains disabled automatic cleanup, external runtimes and pending compaction', () => {
    const disabled = renderView({ status: { ...status, maintenance: { ...status.maintenance, enabled: false } } });
    expect(disabled).toContain('turned off in settings.json');

    const external = renderView({ status: { ...status, managedRuntime: false } });
    expect(external).toContain('only available for the OpenCode runtime');

    const pending = renderView({ status: { ...status, compactionPending: true } });
    expect(pending).toContain('Compaction is scheduled');

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

  test('is mounted by the Data Retention section and its copy lives in the storage namespace', () => {
    expect(retentionSource).toContain("import { OpenCodeStorageSettings } from './OpenCodeStorageSettings';");
    expect(retentionSource).toContain('<OpenCodeStorageSettings />');
    expect(messages).toContain("'settings.openchamber.storage.title': 'OpenCode Storage'");
    expect(messages).toContain("'settings.openchamber.storage.actions.compact': 'Compact Now'");
  });
});
