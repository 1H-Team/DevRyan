import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';

import { withDom } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';
import { botsApi, type BotCatalogBackup, type BotCatalogStatus, type BotsApi } from '@/lib/botsApi';
import { BotCatalogPanel } from './BotCatalogPanel';

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

type Found = { click(): void } | null;
type Searchable = { find: (predicate: (node: { tagName: string; textContent: string | null }) => boolean) => unknown };
const buttons = (container: Searchable, label: string): Found => (
  container.find((node) => node.tagName === 'BUTTON' && node.textContent === label) as Found
);


describe('mounted Bot catalog panel', () => {
  test('reports configuration import bytes and exact setup requirements while imported Bots stay paused', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const api: BotsApi = { ...botsApi, listCatalogBackups: async () => ({ backups: [] }),
      getCatalogStatus: async () => status({ activationHold: { reason: 'import', createdAt: '' }, import: {
        cloud: null, pending: false, import: { id: 'import', mode: 'merge', scope: 'configuration',
          phase: 'completed', running: false, createdAt: '', updatedAt: '', tables: 2, pages: 3, objects: 1,
          downloadedBytes: 4096, error: null, result: { importedBotCount: 1,
            blockers: [{ botId: 'bot-a', kind: 'skill', resourceId: 'skill-a' }] } },
      } }),
    };
    try {
      await act(async () => { root.render(<I18nProvider><BotCatalogPanel variant="full" api={api} /></I18nProvider>); });
      expect(container.textContent).toContain('Imported Bots, routines and Telegram stay paused');
      expect(container.textContent).toContain('4.0 KB downloaded');
      expect(container.textContent).toContain('Bot bot-a: skill skill-a needs local setup.');
    } finally { await act(async () => { root.unmount(); }); }
  }));
  test('renders nothing in compact mode when the catalog needs no action', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const api: BotsApi = { ...botsApi, getCatalogStatus: async () => status() };
    try {
      await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} /></I18nProvider>); });
      expect(container.textContent).toBe('');
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('resumes held Bots with one control and reports the change', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    let held = true;
    let changed = 0;
    const api: BotsApi = {
      ...botsApi,
      getCatalogStatus: async () => status({ activationHold: held ? { reason: 'import', createdAt: '' } : null }),
      resumeBotActivation: async () => { held = false; return { resumed: true }; },
    };
    try {
      await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} onCatalogChanged={() => { changed += 1; }} /></I18nProvider>); });
      expect(container.textContent).toContain('Bots Are Paused');
      await act(async () => { buttons(container, 'Resume Bots')?.click(); });
      expect(changed).toBe(1);
      expect(container.textContent).toBe('');
    } finally { await act(async () => { root.unmount(); }); }
  }));

  // The confirmation dialog portals outside this minimal DOM; the server
  // additionally refuses a restore without the exact confirmation string.
  test('offers the latest verified backup and never restores without confirmation', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const restored: Array<[string, string]> = [];
    const api: BotsApi = {
      ...botsApi,
      getCatalogStatus: async () => status({ state: 'recovery_required', code: 'bot_database_identity_changed' }),
      listCatalogBackups: async () => ({ backups: [backup] }),
      restoreCatalog: async (backupId, confirmation) => { restored.push([backupId, confirmation]); return {}; },
    };
    try {
      await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} /></I18nProvider>); });
      expect(container.textContent).toContain('Bot Storage Needs Recovery');
      expect(container.textContent).toContain('Restore the latest verified backup');
      expect(buttons(container, 'Start Empty')).toBeNull();
      await act(async () => { buttons(container, 'Restore Backup')?.click(); });
      expect(restored).toEqual([]);
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('shows recovery status without controls to a user who is not the owner', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    let listed = 0;
    const api: BotsApi = {
      ...botsApi,
      getCatalogStatus: async () => status({ state: 'recovery_required', viewerIsOwner: false }),
      listCatalogBackups: async () => { listed += 1; return { backups: [backup] }; },
    };
    try {
      await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} /></I18nProvider>); });
      expect(container.textContent).toContain('Only this computer\'s owner can restore Bot storage.');
      expect(buttons(container, 'Restore Backup')).toBeNull();
      expect(listed).toBe(0);
    } finally { await act(async () => { root.unmount(); }); }
  }));
});

test('polls pending hosted discovery until completion and keeps failures separate from local storage', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  let calls = 0;
  let checking = true;
  let failed = false;
  const api: BotsApi = { ...botsApi, getCatalogStatus: async () => {
    calls += 1;
    return status({ import: { checking, cloud: checking ? null : { hasBots: !failed, checkedAt: '', code: failed ? 'bot_import_source_unavailable' : null }, pending: !checking && !failed, import: null } });
  } };
  try {
    await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} /></I18nProvider>); });
    expect(container.textContent).toContain('Checking for Hosted Bots');
    checking = false;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_100)); });
    expect(calls).toBe(2);
    expect(container.textContent).toContain('Hosted Bots Can Be Imported');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_100)); });
    expect(calls).toBe(2);
    failed = true;
    await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} capabilityState="ready" /></I18nProvider>); });
    expect(container.textContent).toContain('Could Not Check Hosted Bots');
    expect(container.textContent).toContain('Bots already on this computer remain available');
    expect(container.textContent).toContain('bot_import_source_unavailable');
  } finally { await act(async () => { root.unmount(); });  }
}), 10_000);

test('asks the hosted workspace only when the owner does', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  let answer: 'quota' | 'found' = 'quota';
  let asked = false;
  let checks = 0;
  const cloud = () => (!asked ? null : answer === 'found'
    ? { hasBots: true, checkedAt: '2026-09-28T00:00:00.000Z', code: null }
    : { hasBots: null, checkedAt: '2026-09-28T00:00:00.000Z', code: 'bot_import_source_quota_exceeded' });
  const importStatus = () => ({ sourceConfigured: true, cloud: cloud(), import: null, pending: asked && answer === 'found' });
  const api: BotsApi = {
    ...botsApi,
    getCatalogStatus: async () => status({ import: importStatus() }),
    listCatalogBackups: async () => ({ backups: [] }),
    checkCatalogImportSource: async () => { checks += 1; asked = true; return importStatus(); },
  };
  try {
    await act(async () => { root.render(<I18nProvider><BotCatalogPanel variant="full" api={api} /></I18nProvider>); });
    // Nothing was asked: no notice, only the quiet request.
    expect(checks).toBe(0);
    expect(container.textContent).not.toContain('Hosted Project Is Over Its Quota');
    expect(container.textContent).not.toContain('Hosted Bots Can Be Imported');

    await act(async () => { buttons(container, 'Check for Hosted Bots')?.click(); });
    expect(checks).toBe(1);
    expect(container.textContent).toContain('Hosted Project Is Over Its Quota');
    expect(container.textContent).toContain('have not been deleted');
    expect(buttons(container, 'Check for Hosted Bots')).toBeNull();

    answer = 'found';
    await act(async () => { buttons(container, 'Check Again')?.click(); });
    expect(checks).toBe(2);
    expect(container.textContent).toContain('Hosted Bots Can Be Imported');
    expect(buttons(container, 'Import Bots')).not.toBeNull();
  } finally { await act(async () => { root.unmount(); }); }
}));

test('keeps the hosted request out of the chat', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const api: BotsApi = {
    ...botsApi,
    getCatalogStatus: async () => status({ import: { sourceConfigured: true, cloud: null, import: null, pending: false } }),
  };
  try {
    await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} /></I18nProvider>); });
    expect(container.textContent).toBe('');
  } finally { await act(async () => { root.unmount(); }); }
}));
